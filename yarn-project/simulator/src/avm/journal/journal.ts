import { MerkleTreeId } from '@aztec/circuit-types';
import { type PublicCallRequest, SerializableContractInstance } from '@aztec/circuits.js';
import { AvmNullifierReadTreeHint, AvmPublicDataReadTreeHint } from '@aztec/circuits.js/avm';
import {
  computeNoteHashNonce,
  computePublicDataTreeLeafSlot,
  computeUniqueNoteHash,
  siloNoteHash,
  siloNullifier,
} from '@aztec/circuits.js/hash';
import { SharedMutableValues, SharedMutableValuesWithHash } from '@aztec/circuits.js/shared-mutable';
import { NullifierLeafPreimage, PublicDataTreeLeafPreimage } from '@aztec/circuits.js/trees';
import {
  CANONICAL_AUTH_REGISTRY_ADDRESS,
  DEPLOYER_CONTRACT_ADDRESS,
  FEE_JUICE_ADDRESS,
  MULTI_CALL_ENTRYPOINT_ADDRESS,
  REGISTERER_CONTRACT_ADDRESS,
  ROUTER_ADDRESS,
} from '@aztec/constants';
import { AztecAddress } from '@aztec/foundation/aztec-address';
import { poseidon2Hash } from '@aztec/foundation/crypto';
import { Fr } from '@aztec/foundation/fields';
import { jsonStringify } from '@aztec/foundation/json-rpc';
import { createLogger } from '@aztec/foundation/log';
import { ProtocolContractAddress } from '@aztec/protocol-contracts';

import { strict as assert } from 'assert';

import { getPublicFunctionDebugName } from '../../common/debug_fn_name.js';
import { type WorldStateDB } from '../../public/public_db_sources.js';
import { type PublicSideEffectTraceInterface } from '../../public/side_effect_trace_interface.js';
import { type AvmExecutionEnvironment } from '../avm_execution_environment.js';
import { AvmEphemeralForest } from '../avm_tree.js';
import { NullifierCollisionError, NullifierManager } from './nullifiers.js';
import { PublicStorage } from './public_storage.js';

/**
 * A class to manage persistable AVM state for contract calls.
 * Maintains a cache of the current world state,
 * a trace of all side effects.
 *
 * The simulator should make any world state / tree queries through this object.
 *
 * Manages merging of successful/reverted child state into current state.
 */
export class AvmPersistableStateManager {
  private readonly log = createLogger('simulator:avm:state_manager');

  /** Make sure a forked state is never merged twice. */
  private alreadyMergedIntoParent = false;

  constructor(
    /** Reference to node storage */
    private readonly worldStateDB: WorldStateDB,
    /** Side effect trace */
    // TODO(5818): make private once no longer accessed in executor
    public readonly trace: PublicSideEffectTraceInterface,
    /** Public storage, including cached writes */
    private readonly publicStorage: PublicStorage = new PublicStorage(worldStateDB),
    /** Nullifier set, including cached/recently-emitted nullifiers */
    private readonly nullifiers: NullifierManager = new NullifierManager(worldStateDB),
    private readonly doMerkleOperations: boolean = false,
    /** Ephmeral forest for merkle tree operations */
    public merkleTrees: AvmEphemeralForest,
    public readonly firstNullifier: Fr,
  ) {}

  /**
   * Create a new state manager
   */
  public static async create(
    worldStateDB: WorldStateDB,
    trace: PublicSideEffectTraceInterface,
    doMerkleOperations: boolean = false,
    firstNullifier: Fr,
  ): Promise<AvmPersistableStateManager> {
    const ephemeralForest = await AvmEphemeralForest.create(worldStateDB.getMerkleInterface());
    return new AvmPersistableStateManager(
      worldStateDB,
      trace,
      /*publicStorage=*/ new PublicStorage(worldStateDB),
      /*nullifiers=*/ new NullifierManager(worldStateDB),
      /*doMerkleOperations=*/ doMerkleOperations,
      ephemeralForest,
      firstNullifier,
    );
  }

  /**
   * Create a new state manager forked from this one
   */
  public fork() {
    return new AvmPersistableStateManager(
      this.worldStateDB,
      this.trace.fork(),
      this.publicStorage.fork(),
      this.nullifiers.fork(),
      this.doMerkleOperations,
      this.merkleTrees.fork(),
      this.firstNullifier,
    );
  }

  /**
   * Accept forked world state modifications & traced side effects / hints
   */
  public merge(forkedState: AvmPersistableStateManager) {
    this._merge(forkedState, /*reverted=*/ false);
  }

  /**
   * Reject forked world state modifications & traced side effects, keep traced hints
   */
  public reject(forkedState: AvmPersistableStateManager) {
    this._merge(forkedState, /*reverted=*/ true);
  }

  private _merge(forkedState: AvmPersistableStateManager, reverted: boolean) {
    // sanity check to avoid merging the same forked trace twice
    assert(
      !forkedState.alreadyMergedIntoParent,
      'Cannot merge forked state that has already been merged into its parent!',
    );
    forkedState.alreadyMergedIntoParent = true;
    this.publicStorage.acceptAndMerge(forkedState.publicStorage);
    this.nullifiers.acceptAndMerge(forkedState.nullifiers);
    this.trace.merge(forkedState.trace, reverted);
    if (reverted) {
      if (this.doMerkleOperations) {
        this.log.trace(
          `Rolled back nullifier tree to root ${this.merkleTrees.treeMap.get(MerkleTreeId.NULLIFIER_TREE)!.getRoot()}`,
        );
      }
    } else {
      this.log.trace('Merging forked state into parent...');
      this.merkleTrees = forkedState.merkleTrees;
    }
  }

  /**
   * Write to public storage, journal/trace the write.
   *
   * @param contractAddress - the address of the contract whose storage is being written to
   * @param slot - the slot in the contract's storage being written to
   * @param value - the value being written to the slot
   */
  public async writeStorage(contractAddress: AztecAddress, slot: Fr, value: Fr, protocolWrite = false): Promise<void> {
    this.log.trace(`Storage write (address=${contractAddress}, slot=${slot}): value=${value}`);
    const leafSlot = await computePublicDataTreeLeafSlot(contractAddress, slot);
    this.log.trace(`leafSlot=${leafSlot}`);
    // Cache storage writes for later reference/reads
    this.publicStorage.write(contractAddress, slot, value);

    if (this.doMerkleOperations) {
      const result = await this.merkleTrees.writePublicStorage(leafSlot, value);
      assert(result !== undefined, 'Public data tree insertion error. You might want to disable doMerkleOperations.');
      this.log.trace(`Inserted public data tree leaf at leafSlot ${leafSlot}, value: ${value}`);

      const lowLeafInfo = result.lowWitness;
      const lowLeafPreimage = result.lowWitness.preimage as PublicDataTreeLeafPreimage;
      const lowLeafIndex = lowLeafInfo.index;
      const lowLeafPath = lowLeafInfo.siblingPath;

      const newLeafPreimage = result.element as PublicDataTreeLeafPreimage;
      let insertionPath: Fr[] | undefined;
      if (!result.update) {
        insertionPath = result.insertionPath;
        assert(
          newLeafPreimage.value.equals(value),
          `Value mismatch when performing public data write (got value: ${value}, value in ephemeral tree: ${newLeafPreimage.value})`,
        );
      }

      await this.trace.tracePublicStorageWrite(
        contractAddress,
        slot,
        value,
        protocolWrite,
        lowLeafPreimage,
        new Fr(lowLeafIndex),
        lowLeafPath,
        newLeafPreimage,
        insertionPath,
      );
    } else {
      await this.trace.tracePublicStorageWrite(contractAddress, slot, value, protocolWrite);
    }
  }

  /**
   * Read from public storage, trace the read.
   *
   * @param contractAddress - the address of the contract whose storage is being read from
   * @param slot - the slot in the contract's storage being read from
   * @returns the latest value written to slot, or 0 if never written to before
   */
  public async readStorage(contractAddress: AztecAddress, slot: Fr): Promise<Fr> {
    const { value, leafPreimage, leafIndex, leafPath } = await this.getPublicDataMembership(contractAddress, slot);

    if (this.doMerkleOperations) {
      this.trace.tracePublicStorageRead(contractAddress, slot, value, leafPreimage, leafIndex, leafPath);
    } else {
      this.trace.tracePublicStorageRead(contractAddress, slot, value);
    }

    return Promise.resolve(value);
  }

  async getPublicDataMembership(
    contractAddress: AztecAddress,
    slot: Fr,
  ): Promise<{
    value: Fr;
    leafPreimage: PublicDataTreeLeafPreimage;
    leafIndex: Fr;
    leafPath: Fr[];
  }> {
    const { value, cached } = await this.publicStorage.read(contractAddress, slot);
    this.log.trace(`Storage read  (address=${contractAddress}, slot=${slot}): value=${value}, cached=${cached}`);
    const leafSlot = await computePublicDataTreeLeafSlot(contractAddress, slot);
    this.log.trace(`leafSlot=${leafSlot}`);

    if (this.doMerkleOperations) {
      // Get leaf if present, low leaf if absent
      // If leaf is present, hint/trace it. Otherwise, hint/trace the low leaf.
      const {
        preimage,
        index: leafIndex,
        alreadyPresent,
      } = await this.merkleTrees.getLeafOrLowLeafInfo(MerkleTreeId.PUBLIC_DATA_TREE, leafSlot);
      // The index and preimage here is either the low leaf or the leaf itself (depending on the value of update flag)
      // In either case, we just want the sibling path to this leaf - it's up to the avm to distinguish if it's a low leaf or not
      const leafPath = await this.merkleTrees.getSiblingPath(MerkleTreeId.PUBLIC_DATA_TREE, leafIndex);
      const leafPreimage = preimage as PublicDataTreeLeafPreimage;

      this.log.trace(`leafPreimage.slot: ${leafPreimage.slot}, leafPreimage.value: ${leafPreimage.value}`);
      this.log.trace(
        `leafPreimage.nextSlot: ${leafPreimage.nextSlot}, leafPreimage.nextIndex: ${Number(leafPreimage.nextIndex)}`,
      );

      if (alreadyPresent) {
        assert(
          leafPreimage.value.equals(value),
          `Value mismatch when performing public data read (got value: ${value}, value in ephemeral tree: ${leafPreimage.value})`,
        );
      } else {
        this.log.trace(`Slot has never been written before!`);
        // Sanity check that the leaf slot is skipped by low leaf when it doesn't exist
        assert(
          leafPreimage.slot.toBigInt() < leafSlot.toBigInt() &&
            (leafPreimage.nextIndex === 0n || leafPreimage.nextSlot.toBigInt() > leafSlot.toBigInt()),
          'Public data tree low leaf should skip the target leaf slot when the target leaf does not exist or is the max value.',
        );
      }
      return {
        value,
        leafPreimage,
        leafIndex: new Fr(leafIndex),
        leafPath,
      };
    } else {
      return {
        value,
        leafPreimage: PublicDataTreeLeafPreimage.empty(),
        leafIndex: Fr.ZERO,
        leafPath: [],
      };
    }
  }

  /**
   * Read from public storage, don't trace the read.
   *
   * @param contractAddress - the address of the contract whose storage is being read from
   * @param slot - the slot in the contract's storage being read from
   * @returns the latest value written to slot, or 0 if never written to before
   */
  public async peekStorage(contractAddress: AztecAddress, slot: Fr): Promise<Fr> {
    const { value, cached } = await this.publicStorage.read(contractAddress, slot);
    this.log.trace(`Storage peek  (address=${contractAddress}, slot=${slot}): value=${value},  cached=${cached}`);
    return Promise.resolve(value);
  }

  // TODO(4886): We currently don't silo note hashes.
  /**
   * Check if a note hash exists at the given leaf index, trace the check.
   *
   * @param contractAddress - the address of the contract whose storage is being read from
   * @param noteHash - the unsiloed note hash being checked
   * @param leafIndex - the leaf index being checked
   * @returns true if the note hash exists at the given leaf index, false otherwise
   */
  public async checkNoteHashExists(contractAddress: AztecAddress, noteHash: Fr, leafIndex: Fr): Promise<boolean> {
    const gotLeafValue = (await this.worldStateDB.getCommitmentValue(leafIndex.toBigInt())) ?? Fr.ZERO;
    const exists = gotLeafValue.equals(noteHash);
    this.log.trace(
      `noteHashes(${contractAddress})@${noteHash} ?? leafIndex: ${leafIndex} | gotLeafValue: ${gotLeafValue}, exists: ${exists}.`,
    );
    if (this.doMerkleOperations) {
      // TODO(8287): We still return exists here, but we need to transmit both the requested noteHash and the gotLeafValue
      // such that the VM can constrain the equality and decide on exists based on that.
      const path = await this.merkleTrees.getSiblingPath(MerkleTreeId.NOTE_HASH_TREE, leafIndex.toBigInt());
      this.trace.traceNoteHashCheck(contractAddress, gotLeafValue, leafIndex, exists, path);
    } else {
      this.trace.traceNoteHashCheck(contractAddress, gotLeafValue, leafIndex, exists);
    }
    return Promise.resolve(exists);
  }

  /**
   * Write a raw note hash, silo it and make it unique, then trace the write.
   * @param noteHash - the unsiloed note hash to write
   */
  public async writeNoteHash(contractAddress: AztecAddress, noteHash: Fr): Promise<void> {
    const siloedNoteHash = await siloNoteHash(contractAddress, noteHash);

    await this.writeSiloedNoteHash(siloedNoteHash);
  }

  /**
   * Write a note hash, make it unique, trace the write.
   * @param noteHash - the non unique note hash to write
   */
  public async writeSiloedNoteHash(noteHash: Fr): Promise<void> {
    const nonce = await computeNoteHashNonce(this.firstNullifier, this.trace.getNoteHashCount());
    const uniqueNoteHash = await computeUniqueNoteHash(nonce, noteHash);

    await this.writeUniqueNoteHash(uniqueNoteHash);
  }

  /**
   * Write a note hash, trace the write.
   * @param noteHash - the siloed unique hash to write
   */
  public async writeUniqueNoteHash(noteHash: Fr): Promise<void> {
    this.log.trace(`noteHashes += @${noteHash}.`);

    if (this.doMerkleOperations) {
      // Should write a helper for this
      const leafIndex = new Fr(this.merkleTrees.treeMap.get(MerkleTreeId.NOTE_HASH_TREE)!.leafCount);
      const insertionPath = await this.merkleTrees.appendNoteHash(noteHash);
      this.trace.traceNewNoteHash(noteHash, leafIndex, insertionPath);
    } else {
      this.trace.traceNewNoteHash(noteHash);
    }
  }

  /**
   * Check if a nullifier exists, trace the check.
   * @param contractAddress - address of the contract that the nullifier is associated with
   * @param nullifier - the unsiloed nullifier to check
   * @returns exists - whether the nullifier exists in the nullifier set
   */
  public async checkNullifierExists(contractAddress: AztecAddress, nullifier: Fr): Promise<boolean> {
    this.log.trace(`Checking existence of nullifier (address=${contractAddress}, nullifier=${nullifier})`);
    const siloedNullifier = await siloNullifier(contractAddress, nullifier);
    const [exists, leafOrLowLeafPreimage, leafOrLowLeafIndex, leafOrLowLeafPath] = await this.getNullifierMembership(
      siloedNullifier,
    );

    if (this.doMerkleOperations) {
      this.trace.traceNullifierCheck(
        siloedNullifier,
        exists,
        leafOrLowLeafPreimage,
        leafOrLowLeafIndex,
        leafOrLowLeafPath,
      );
    } else {
      this.trace.traceNullifierCheck(siloedNullifier, exists);
    }
    return Promise.resolve(exists);
  }

  /**
   * Helper to get membership information for a siloed nullifier when checking its existence.
   * Optionally trace the nullifier check.
   *
   * @param siloedNullifier - the siloed nullifier to get membership information for
   * @returns
   *     - exists - whether the nullifier exists in the nullifier set
   *     - leafOrLowLeafPreimage - the preimage of the nullifier leaf or its low-leaf if it doesn't exist
   *     - leafOrLowLeafIndex - the leaf index of the nullifier leaf or its low-leaf if it doesn't exist
   *     - leafOrLowLeafPath - the sibling path of the nullifier leaf or its low-leaf if it doesn't exist
   */
  private async getNullifierMembership(
    siloedNullifier: Fr,
  ): Promise<
    [
      /*exists=*/ boolean,
      /*leafOrLowLeafPreimage=*/ NullifierLeafPreimage,
      /*leafOrLowLeafIndex=*/ Fr,
      /*leafOrLowLeafIndexPath=*/ Fr[],
    ]
  > {
    const [exists, isPending, _] = await this.nullifiers.checkExists(siloedNullifier);
    this.log.trace(`Checked siloed nullifier ${siloedNullifier} (exists=${exists}), pending=${isPending}`);

    if (this.doMerkleOperations) {
      // Get leaf if present, low leaf if absent
      // If leaf is present, hint/trace it. Otherwise, hint/trace the low leaf.
      const {
        preimage,
        index: leafIndex,
        alreadyPresent,
      } = await this.merkleTrees.getLeafOrLowLeafInfo(MerkleTreeId.NULLIFIER_TREE, siloedNullifier);
      const leafPreimage = preimage as NullifierLeafPreimage;
      const leafPath = await this.merkleTrees.getSiblingPath(MerkleTreeId.NULLIFIER_TREE, leafIndex);

      assert(
        alreadyPresent == exists,
        'WorldStateDB contains nullifier leaf, but merkle tree does not (or vice versa).... This is a bug!',
      );

      if (exists) {
        this.log.trace(`Siloed nullifier ${siloedNullifier} exists at leafIndex=${leafIndex}`);
      } else {
        // Sanity check that the leaf value is skipped by low leaf when it doesn't exist
        assert(
          leafPreimage.nullifier.toBigInt() < siloedNullifier.toBigInt() &&
            (leafPreimage.nextIndex === 0n || leafPreimage.nextNullifier.toBigInt() > siloedNullifier.toBigInt()),
          'Nullifier tree low leaf should skip the target leaf nullifier when the target leaf does not exist.',
        );
      }
      return [exists, leafPreimage, new Fr(leafIndex), leafPath];
    } else {
      return [exists, NullifierLeafPreimage.empty(), Fr.ZERO, []];
    }
  }

  /**
   * Write a nullifier to the nullifier set, trace the write.
   * @param contractAddress - address of the contract that the nullifier is associated with
   * @param nullifier - the unsiloed nullifier to write
   */
  public async writeNullifier(contractAddress: AztecAddress, nullifier: Fr) {
    this.log.trace(`Inserting new nullifier (address=${nullifier}, nullifier=${contractAddress})`);
    const siloedNullifier = await siloNullifier(contractAddress, nullifier);
    await this.writeSiloedNullifier(siloedNullifier);
  }

  /**
   * Write a nullifier to the nullifier set, trace the write.
   * @param siloedNullifier - the siloed nullifier to write
   */
  public async writeSiloedNullifier(siloedNullifier: Fr) {
    this.log.trace(`Inserting siloed nullifier=${siloedNullifier}`);

    if (this.doMerkleOperations) {
      // Maybe overkill, but we should check if the nullifier is already present in the tree before attempting to insert
      // It might be better to catch the error from the insert operation
      // Trace all nullifier creations, even duplicate insertions that fail
      const { preimage, index, alreadyPresent } = await this.merkleTrees.getLeafOrLowLeafInfo(
        MerkleTreeId.NULLIFIER_TREE,
        siloedNullifier,
      );
      if (alreadyPresent) {
        this.log.verbose(`Siloed nullifier ${siloedNullifier} already present in tree at index ${index}!`);
        // If the nullifier is already present, we should not insert it again
        // instead we provide the direct membership path
        const path = await this.merkleTrees.getSiblingPath(MerkleTreeId.NULLIFIER_TREE, index);
        // This just becomes a nullifier read hint
        this.trace.traceNullifierCheck(
          siloedNullifier,
          /*exists=*/ alreadyPresent,
          preimage as NullifierLeafPreimage,
          new Fr(index),
          path,
        );
        throw new NullifierCollisionError(
          `Siloed nullifier ${siloedNullifier} already exists in parent cache or host.`,
        );
      } else {
        // Cache pending nullifiers for later access
        await this.nullifiers.append(siloedNullifier);
        // We append the new nullifier
        this.log.trace(
          `Nullifier tree root before insertion ${await this.merkleTrees.treeMap
            .get(MerkleTreeId.NULLIFIER_TREE)!
            .getRoot()}`,
        );
        const appendResult = await this.merkleTrees.appendNullifier(siloedNullifier);
        this.log.trace(
          `Nullifier tree root after insertion ${await this.merkleTrees.treeMap
            .get(MerkleTreeId.NULLIFIER_TREE)!
            .getRoot()}`,
        );
        const lowLeafPreimage = appendResult.lowWitness.preimage as NullifierLeafPreimage;
        const lowLeafIndex = appendResult.lowWitness.index;
        const lowLeafPath = appendResult.lowWitness.siblingPath;
        const insertionPath = appendResult.insertionPath;
        this.trace.traceNewNullifier(
          siloedNullifier,
          lowLeafPreimage,
          new Fr(lowLeafIndex),
          lowLeafPath,
          insertionPath,
        );
      }
    } else {
      // Cache pending nullifiers for later access
      await this.nullifiers.append(siloedNullifier);
      this.trace.traceNewNullifier(siloedNullifier);
    }
  }

  public async writeSiloedNullifiersFromPrivate(siloedNullifiers: Fr[]) {
    for (const siloedNullifier of siloedNullifiers.filter(n => !n.isEmpty())) {
      await this.writeSiloedNullifier(siloedNullifier);
    }
  }

  /**
   * Check if an L1 to L2 message exists, trace the check.
   * @param msgHash - the message hash to check existence of
   * @param msgLeafIndex - the message leaf index to use in the check
   * @returns exists - whether the message exists in the L1 to L2 Messages tree
   */
  public async checkL1ToL2MessageExists(
    contractAddress: AztecAddress,
    msgHash: Fr,
    msgLeafIndex: Fr,
  ): Promise<boolean> {
    const valueAtIndex = (await this.worldStateDB.getL1ToL2LeafValue(msgLeafIndex.toBigInt())) ?? Fr.ZERO;
    const exists = valueAtIndex.equals(msgHash);
    this.log.trace(
      `l1ToL2Messages(@${msgLeafIndex}) ?? exists: ${exists}, expected: ${msgHash}, found: ${valueAtIndex}.`,
    );

    if (this.doMerkleOperations) {
      // TODO(8287): We still return exists here, but we need to transmit both the requested msgHash and the value
      // such that the VM can constrain the equality and decide on exists based on that.
      // We should defintely add a helper here
      const path = await this.merkleTrees.treeDb.getSiblingPath(
        MerkleTreeId.L1_TO_L2_MESSAGE_TREE,
        msgLeafIndex.toBigInt(),
      );
      this.trace.traceL1ToL2MessageCheck(contractAddress, valueAtIndex, msgLeafIndex, exists, path.toFields());
    } else {
      this.trace.traceL1ToL2MessageCheck(contractAddress, valueAtIndex, msgLeafIndex, exists);
    }
    return Promise.resolve(exists);
  }

  /**
   * Write an L2 to L1 message.
   * @param contractAddress - L2 contract address that created this message
   * @param recipient - L1 contract address to send the message to.
   * @param content - Message content.
   */
  public writeL2ToL1Message(contractAddress: AztecAddress, recipient: Fr, content: Fr) {
    this.log.trace(`L2ToL1Messages(${contractAddress}) += (recipient: ${recipient}, content: ${content}).`);
    this.trace.traceNewL2ToL1Message(contractAddress, recipient, content);
  }

  /**
   * Write a public log
   * @param contractAddress - address of the contract that emitted the log
   * @param log - log contents
   */
  public writePublicLog(contractAddress: AztecAddress, log: Fr[]) {
    this.log.trace(`PublicLog(${contractAddress}) += event with ${log.length} fields.`);
    this.trace.tracePublicLog(contractAddress, log);
  }

  /**
   * Get a contract instance.
   * @param contractAddress - address of the contract instance to retrieve.
   * @returns the contract instance or undefined if it does not exist.
   */
  public async getContractInstance(contractAddress: AztecAddress): Promise<SerializableContractInstance | undefined> {
    this.log.trace(`Getting contract instance for address ${contractAddress}`);
    const instanceWithAddress = await this.worldStateDB.getContractInstance(contractAddress);
    const exists = instanceWithAddress !== undefined;

    let nullifierMembership = AvmNullifierReadTreeHint.empty();
    let updateMembership = AvmPublicDataReadTreeHint.empty();
    let updatePreimage: Fr[] = [];
    if (!contractAddressIsCanonical(contractAddress)) {
      const contractAddressNullifier = await siloNullifier(
        AztecAddress.fromNumber(DEPLOYER_CONTRACT_ADDRESS),
        contractAddress.toField(),
      );
      const [
        nullifierExistsInTree,
        nullifierLeafOrLowLeafPreimage,
        nullifierLeafOrLowLeafIndex,
        nullifierLeafOrLowLeafPath,
      ] = await this.getNullifierMembership(/*siloedNullifier=*/ contractAddressNullifier);
      nullifierMembership = new AvmNullifierReadTreeHint(
        nullifierLeafOrLowLeafPreimage,
        nullifierLeafOrLowLeafIndex,
        nullifierLeafOrLowLeafPath,
      );
      assert(
        exists == nullifierExistsInTree,
        'WorldStateDB contains contract instance, but nullifier tree does not contain contract address (or vice versa).... This is a bug!',
      );

      ({ updateMembership, updatePreimage } = await this.getContractUpdateHints(contractAddress));
    }

    if (exists) {
      const instance = new SerializableContractInstance(instanceWithAddress);
      this.log.trace(
        `Got contract instance (address=${contractAddress}): exists=${exists}, instance=${jsonStringify(instance)}`,
      );
      if (this.doMerkleOperations) {
        this.trace.traceGetContractInstance(
          contractAddress,
          exists,
          instance,
          nullifierMembership,
          updateMembership,
          updatePreimage,
        );
      } else {
        this.trace.traceGetContractInstance(contractAddress, exists, instance);
      }

      return Promise.resolve(instance);
    } else {
      this.log.debug(`Contract instance NOT FOUND (address=${contractAddress})`);
      if (this.doMerkleOperations) {
        this.trace.traceGetContractInstance(
          contractAddress,
          exists,
          /*instance=*/ undefined,
          nullifierMembership,
          updateMembership,
          updatePreimage,
        );
      } else {
        this.trace.traceGetContractInstance(contractAddress, exists);
      }
      return Promise.resolve(undefined);
    }
  }

  /**
   * Get a contract's bytecode from the contracts DB, also trace the contract class and instance
   */
  public async getBytecode(contractAddress: AztecAddress): Promise<Buffer | undefined> {
    this.log.debug(`Getting bytecode for contract address ${contractAddress}`);
    const instanceWithAddress = await this.worldStateDB.getContractInstance(contractAddress);
    const exists = instanceWithAddress !== undefined;

    let nullifierMembership = AvmNullifierReadTreeHint.empty();
    let updateMembership = AvmPublicDataReadTreeHint.empty();
    let updatePreimage: Fr[] = [];

    if (!contractAddressIsCanonical(contractAddress)) {
      const contractAddressNullifier = await siloNullifier(
        AztecAddress.fromNumber(DEPLOYER_CONTRACT_ADDRESS),
        contractAddress.toField(),
      );
      const [
        nullifierExistsInTree,
        nullifierLeafOrLowLeafPreimage,
        nullifierLeafOrLowLeafIndex,
        nullifierLeafOrLowLeafPath,
      ] = await this.getNullifierMembership(/*siloedNullifier=*/ contractAddressNullifier);
      assert(
        exists == nullifierExistsInTree,
        'WorldStateDB contains contract instance, but nullifier tree does not contain contract address (or vice versa).... This is a bug!',
      );
      nullifierMembership = new AvmNullifierReadTreeHint(
        nullifierLeafOrLowLeafPreimage,
        nullifierLeafOrLowLeafIndex,
        nullifierLeafOrLowLeafPath,
      );

      ({ updateMembership, updatePreimage } = await this.getContractUpdateHints(contractAddress));
    }

    if (exists) {
      const instance = new SerializableContractInstance(instanceWithAddress);
      const contractClass = await this.worldStateDB.getContractClass(instance.currentContractClassId);
      const bytecodeCommitment = await this.worldStateDB.getBytecodeCommitment(instance.currentContractClassId);

      assert(
        contractClass,
        `Contract class not found in DB, but a contract instance was found with this class ID (${instance.currentContractClassId}). This should not happen!`,
      );

      assert(
        bytecodeCommitment,
        `Bytecode commitment was not found in DB for contract class (${instance.currentContractClassId}). This should not happen!`,
      );

      const contractClassPreimage = {
        artifactHash: contractClass.artifactHash,
        privateFunctionsRoot: contractClass.privateFunctionsRoot,
        publicBytecodeCommitment: bytecodeCommitment,
      };

      if (this.doMerkleOperations) {
        this.trace.traceGetBytecode(
          contractAddress,
          exists,
          contractClass.packedBytecode,
          instance,
          contractClassPreimage,
          nullifierMembership,
          updateMembership,
          updatePreimage,
        );
      } else {
        this.trace.traceGetBytecode(
          contractAddress,
          exists,
          contractClass.packedBytecode,
          instance,
          contractClassPreimage,
        );
      }

      return contractClass.packedBytecode;
    } else {
      // If the contract instance is not found, we assume it has not been deployed.
      // It doesnt matter what the values of the contract instance are in this case, as long as we tag it with exists=false.
      // This will hint to the avm circuit to just perform the non-membership check on the address and disregard the bytecode hash
      if (this.doMerkleOperations) {
        this.trace.traceGetBytecode(
          contractAddress,
          exists,
          /*instance=*/ undefined,
          /*contractClass=*/ undefined,
          /*bytecode=*/ undefined,
          nullifierMembership,
          updateMembership,
          updatePreimage,
        );
      } else {
        this.trace.traceGetBytecode(contractAddress, exists); // bytecode, instance, class undefined
      }
      return undefined;
    }
  }

  async getContractUpdateHints(contractAddress: AztecAddress) {
    const { sharedMutableSlot, sharedMutableHashSlot } = await SharedMutableValuesWithHash.getContractUpdateSlots(
      contractAddress,
    );

    const {
      value: hash,
      leafPreimage,
      leafIndex,
      leafPath,
    } = await this.getPublicDataMembership(ProtocolContractAddress.ContractInstanceDeployer, sharedMutableHashSlot);
    const updateMembership = new AvmPublicDataReadTreeHint(leafPreimage, leafIndex, leafPath);

    const readStorage = async (storageSlot: Fr) =>
      (await this.publicStorage.read(ProtocolContractAddress.ContractInstanceDeployer, storageSlot)).value;

    const sharedMutableValues = await SharedMutableValues.readFromTree(sharedMutableSlot, readStorage);

    const updatePreimage = sharedMutableValues.toFields();

    if (!hash.isZero()) {
      const hashed = await poseidon2Hash(updatePreimage);
      if (!hashed.equals(hash)) {
        throw new Error(`Update hint hash mismatch: ${hash} != ${hashed}`);
      }
      this.log.trace(`Non empty update hint found for contract ${contractAddress}`);
    } else {
      if (updatePreimage.some(f => !f.isZero())) {
        throw new Error(`Update hint hash is zero, but update preimage is not: ${updatePreimage}`);
      }
      this.log.trace(`No update hint found for contract ${contractAddress}`);
    }

    return {
      updateMembership,
      updatePreimage,
    };
  }

  public traceEnqueuedCall(publicCallRequest: PublicCallRequest, calldata: Fr[], reverted: boolean) {
    this.trace.traceEnqueuedCall(publicCallRequest, calldata, reverted);
  }

  public async getPublicFunctionDebugName(avmEnvironment: AvmExecutionEnvironment): Promise<string> {
    return await getPublicFunctionDebugName(this.worldStateDB, avmEnvironment.address, avmEnvironment.calldata);
  }
}

function contractAddressIsCanonical(contractAddress: AztecAddress): boolean {
  return (
    contractAddress.equals(AztecAddress.fromNumber(CANONICAL_AUTH_REGISTRY_ADDRESS)) ||
    contractAddress.equals(AztecAddress.fromNumber(DEPLOYER_CONTRACT_ADDRESS)) ||
    contractAddress.equals(AztecAddress.fromNumber(REGISTERER_CONTRACT_ADDRESS)) ||
    contractAddress.equals(AztecAddress.fromNumber(MULTI_CALL_ENTRYPOINT_ADDRESS)) ||
    contractAddress.equals(AztecAddress.fromNumber(FEE_JUICE_ADDRESS)) ||
    contractAddress.equals(AztecAddress.fromNumber(ROUTER_ADDRESS))
  );
}
