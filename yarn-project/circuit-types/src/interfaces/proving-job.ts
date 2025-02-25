import {
  BaseParityInputs,
  ParityPublicInputs,
  RecursiveProof,
  RootParityInputs,
  VerificationKeyData,
} from '@aztec/circuits.js';
import { AvmCircuitInputs } from '@aztec/circuits.js/avm';
import {
  BaseOrMergeRollupPublicInputs,
  BlockMergeRollupInputs,
  BlockRootOrBlockMergePublicInputs,
  BlockRootRollupInputs,
  EmptyBlockRootRollupInputs,
  MergeRollupInputs,
  PrivateBaseRollupInputs,
  PublicBaseRollupInputs,
  RootRollupInputs,
  RootRollupPublicInputs,
  SingleTxBlockRootRollupInputs,
  TubeInputs,
} from '@aztec/circuits.js/rollup';
import {
  AVM_PROOF_LENGTH_IN_FIELDS,
  NESTED_RECURSIVE_PROOF_LENGTH,
  NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH,
  RECURSIVE_PROOF_LENGTH,
  TUBE_PROOF_LENGTH,
} from '@aztec/constants';
import { type ZodFor } from '@aztec/foundation/schemas';

import { z } from 'zod';

import { type ServerCircuitName } from '../stats/index.js';

export type ProofAndVerificationKey<N extends number> = {
  proof: RecursiveProof<N>;
  verificationKey: VerificationKeyData;
};

function schemaForRecursiveProofAndVerificationKey<N extends number>(
  proofLength: N,
): ZodFor<ProofAndVerificationKey<N>> {
  return z.object({
    proof: RecursiveProof.schemaFor(proofLength),
    verificationKey: VerificationKeyData.schema,
  });
}

export function makeProofAndVerificationKey<N extends number>(
  proof: RecursiveProof<N>,
  verificationKey: VerificationKeyData,
): ProofAndVerificationKey<N> {
  return { proof, verificationKey };
}

export type PublicInputsAndRecursiveProof<T, N extends number = typeof NESTED_RECURSIVE_PROOF_LENGTH> = {
  inputs: T;
  proof: RecursiveProof<N>;
  verificationKey: VerificationKeyData;
};

function schemaForPublicInputsAndRecursiveProof<T extends object, N extends number>(
  inputs: ZodFor<T>,
  proofSize: N,
): ZodFor<PublicInputsAndRecursiveProof<T, typeof proofSize>> {
  return z.object({
    inputs,
    proof: RecursiveProof.schemaFor(proofSize),
    verificationKey: VerificationKeyData.schema,
  }) as ZodFor<PublicInputsAndRecursiveProof<T, N>>;
}

export function makePublicInputsAndRecursiveProof<T, N extends number = typeof NESTED_RECURSIVE_PROOF_LENGTH>(
  inputs: T,
  proof: RecursiveProof<N>,
  verificationKey: VerificationKeyData,
): PublicInputsAndRecursiveProof<T, N> {
  return { inputs, proof, verificationKey };
}

export enum ProvingRequestType {
  PUBLIC_VM,

  PRIVATE_BASE_ROLLUP,
  PUBLIC_BASE_ROLLUP,
  MERGE_ROLLUP,
  EMPTY_BLOCK_ROOT_ROLLUP,
  BLOCK_ROOT_ROLLUP,
  SINGLE_TX_BLOCK_ROOT_ROLLUP,
  BLOCK_MERGE_ROLLUP,
  ROOT_ROLLUP,

  BASE_PARITY,
  ROOT_PARITY,
  /** Recursive Client IVC verification to connect private to public or rollup */
  TUBE_PROOF,
}

export function mapProvingRequestTypeToCircuitName(type: ProvingRequestType): ServerCircuitName {
  switch (type) {
    case ProvingRequestType.PUBLIC_VM:
      return 'avm-circuit';
    case ProvingRequestType.PRIVATE_BASE_ROLLUP:
      return 'private-base-rollup';
    case ProvingRequestType.PUBLIC_BASE_ROLLUP:
      return 'public-base-rollup';
    case ProvingRequestType.MERGE_ROLLUP:
      return 'merge-rollup';
    case ProvingRequestType.EMPTY_BLOCK_ROOT_ROLLUP:
      return 'empty-block-root-rollup';
    case ProvingRequestType.BLOCK_ROOT_ROLLUP:
      return 'block-root-rollup';
    case ProvingRequestType.SINGLE_TX_BLOCK_ROOT_ROLLUP:
      return 'single-tx-block-root-rollup';
    case ProvingRequestType.BLOCK_MERGE_ROLLUP:
      return 'block-merge-rollup';
    case ProvingRequestType.ROOT_ROLLUP:
      return 'root-rollup';
    case ProvingRequestType.BASE_PARITY:
      return 'base-parity';
    case ProvingRequestType.ROOT_PARITY:
      return 'root-parity';
    case ProvingRequestType.TUBE_PROOF:
      return 'tube-circuit';
    default: {
      const _exhaustive: never = type;
      throw new Error(`Cannot find circuit name for proving request type: ${type}`);
    }
  }
}
export type AvmProvingRequest = z.infer<typeof AvmProvingRequestSchema>;

export const AvmProvingRequestSchema = z.object({
  type: z.literal(ProvingRequestType.PUBLIC_VM),
  inputs: AvmCircuitInputs.schema,
});

export const ProvingJobInputs = z.discriminatedUnion('type', [
  AvmProvingRequestSchema,
  z.object({ type: z.literal(ProvingRequestType.BASE_PARITY), inputs: BaseParityInputs.schema }),
  z.object({ type: z.literal(ProvingRequestType.ROOT_PARITY), inputs: RootParityInputs.schema }),
  z.object({ type: z.literal(ProvingRequestType.PRIVATE_BASE_ROLLUP), inputs: PrivateBaseRollupInputs.schema }),
  z.object({ type: z.literal(ProvingRequestType.PUBLIC_BASE_ROLLUP), inputs: PublicBaseRollupInputs.schema }),
  z.object({ type: z.literal(ProvingRequestType.MERGE_ROLLUP), inputs: MergeRollupInputs.schema }),
  z.object({ type: z.literal(ProvingRequestType.BLOCK_ROOT_ROLLUP), inputs: BlockRootRollupInputs.schema }),
  z.object({
    type: z.literal(ProvingRequestType.SINGLE_TX_BLOCK_ROOT_ROLLUP),
    inputs: SingleTxBlockRootRollupInputs.schema,
  }),
  z.object({ type: z.literal(ProvingRequestType.EMPTY_BLOCK_ROOT_ROLLUP), inputs: EmptyBlockRootRollupInputs.schema }),
  z.object({ type: z.literal(ProvingRequestType.BLOCK_MERGE_ROLLUP), inputs: BlockMergeRollupInputs.schema }),
  z.object({ type: z.literal(ProvingRequestType.ROOT_ROLLUP), inputs: RootRollupInputs.schema }),
  z.object({ type: z.literal(ProvingRequestType.TUBE_PROOF), inputs: TubeInputs.schema }),
]);

export function getProvingJobInputClassFor(type: ProvingRequestType) {
  switch (type) {
    case ProvingRequestType.PUBLIC_VM:
      return AvmCircuitInputs;
    case ProvingRequestType.PRIVATE_BASE_ROLLUP:
      return PrivateBaseRollupInputs;
    case ProvingRequestType.PUBLIC_BASE_ROLLUP:
      return PublicBaseRollupInputs;
    case ProvingRequestType.MERGE_ROLLUP:
      return MergeRollupInputs;
    case ProvingRequestType.EMPTY_BLOCK_ROOT_ROLLUP:
      return EmptyBlockRootRollupInputs;
    case ProvingRequestType.BLOCK_ROOT_ROLLUP:
      return BlockRootRollupInputs;
    case ProvingRequestType.SINGLE_TX_BLOCK_ROOT_ROLLUP:
      return SingleTxBlockRootRollupInputs;
    case ProvingRequestType.BLOCK_MERGE_ROLLUP:
      return BlockMergeRollupInputs;
    case ProvingRequestType.ROOT_ROLLUP:
      return RootRollupInputs;
    case ProvingRequestType.BASE_PARITY:
      return BaseParityInputs;
    case ProvingRequestType.ROOT_PARITY:
      return RootParityInputs;
    case ProvingRequestType.TUBE_PROOF:
      return TubeInputs;
    default: {
      const _exhaustive: never = type;
      throw new Error(`Cannot find circuit inputs class for proving type ${type}`);
    }
  }
}

export type ProvingJobInputs = z.infer<typeof ProvingJobInputs>;

export type ProvingJobInputsMap = {
  [ProvingRequestType.PUBLIC_VM]: AvmCircuitInputs;
  [ProvingRequestType.PRIVATE_BASE_ROLLUP]: PrivateBaseRollupInputs;
  [ProvingRequestType.PUBLIC_BASE_ROLLUP]: PublicBaseRollupInputs;
  [ProvingRequestType.MERGE_ROLLUP]: MergeRollupInputs;
  [ProvingRequestType.EMPTY_BLOCK_ROOT_ROLLUP]: EmptyBlockRootRollupInputs;
  [ProvingRequestType.BLOCK_ROOT_ROLLUP]: BlockRootRollupInputs;
  [ProvingRequestType.SINGLE_TX_BLOCK_ROOT_ROLLUP]: SingleTxBlockRootRollupInputs;
  [ProvingRequestType.BLOCK_MERGE_ROLLUP]: BlockMergeRollupInputs;
  [ProvingRequestType.ROOT_ROLLUP]: RootRollupInputs;
  [ProvingRequestType.BASE_PARITY]: BaseParityInputs;
  [ProvingRequestType.ROOT_PARITY]: RootParityInputs;
  [ProvingRequestType.TUBE_PROOF]: TubeInputs;
};

export const ProvingJobResult = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(ProvingRequestType.PUBLIC_VM),
    result: schemaForRecursiveProofAndVerificationKey(AVM_PROOF_LENGTH_IN_FIELDS),
  }),
  z.object({
    type: z.literal(ProvingRequestType.PRIVATE_BASE_ROLLUP),
    result: schemaForPublicInputsAndRecursiveProof(
      BaseOrMergeRollupPublicInputs.schema,
      NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH,
    ),
  }),
  z.object({
    type: z.literal(ProvingRequestType.PUBLIC_BASE_ROLLUP),
    result: schemaForPublicInputsAndRecursiveProof(
      BaseOrMergeRollupPublicInputs.schema,
      NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH,
    ),
  }),
  z.object({
    type: z.literal(ProvingRequestType.MERGE_ROLLUP),
    result: schemaForPublicInputsAndRecursiveProof(
      BaseOrMergeRollupPublicInputs.schema,
      NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH,
    ),
  }),
  z.object({
    type: z.literal(ProvingRequestType.EMPTY_BLOCK_ROOT_ROLLUP),
    result: schemaForPublicInputsAndRecursiveProof(
      BlockRootOrBlockMergePublicInputs.schema,
      NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH,
    ),
  }),
  z.object({
    type: z.literal(ProvingRequestType.BLOCK_ROOT_ROLLUP),
    result: schemaForPublicInputsAndRecursiveProof(
      BlockRootOrBlockMergePublicInputs.schema,
      NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH,
    ),
  }),
  z.object({
    type: z.literal(ProvingRequestType.SINGLE_TX_BLOCK_ROOT_ROLLUP),
    result: schemaForPublicInputsAndRecursiveProof(
      BlockRootOrBlockMergePublicInputs.schema,
      NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH,
    ),
  }),
  z.object({
    type: z.literal(ProvingRequestType.BLOCK_MERGE_ROLLUP),
    result: schemaForPublicInputsAndRecursiveProof(
      BlockRootOrBlockMergePublicInputs.schema,
      NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH,
    ),
  }),
  z.object({
    type: z.literal(ProvingRequestType.ROOT_ROLLUP),
    result: schemaForPublicInputsAndRecursiveProof(RootRollupPublicInputs.schema, NESTED_RECURSIVE_PROOF_LENGTH),
  }),
  z.object({
    type: z.literal(ProvingRequestType.BASE_PARITY),
    result: schemaForPublicInputsAndRecursiveProof(ParityPublicInputs.schema, RECURSIVE_PROOF_LENGTH),
  }),
  z.object({
    type: z.literal(ProvingRequestType.ROOT_PARITY),
    result: schemaForPublicInputsAndRecursiveProof(ParityPublicInputs.schema, NESTED_RECURSIVE_PROOF_LENGTH),
  }),
  z.object({
    type: z.literal(ProvingRequestType.TUBE_PROOF),
    result: schemaForRecursiveProofAndVerificationKey(TUBE_PROOF_LENGTH),
  }),
]);
export type ProvingJobResult = z.infer<typeof ProvingJobResult>;
export type ProvingJobResultsMap = {
  [ProvingRequestType.PUBLIC_VM]: ProofAndVerificationKey<typeof AVM_PROOF_LENGTH_IN_FIELDS>;
  [ProvingRequestType.PRIVATE_BASE_ROLLUP]: PublicInputsAndRecursiveProof<
    BaseOrMergeRollupPublicInputs,
    typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH
  >;
  [ProvingRequestType.PUBLIC_BASE_ROLLUP]: PublicInputsAndRecursiveProof<
    BaseOrMergeRollupPublicInputs,
    typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH
  >;
  [ProvingRequestType.MERGE_ROLLUP]: PublicInputsAndRecursiveProof<
    BaseOrMergeRollupPublicInputs,
    typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH
  >;
  [ProvingRequestType.EMPTY_BLOCK_ROOT_ROLLUP]: PublicInputsAndRecursiveProof<
    BlockRootOrBlockMergePublicInputs,
    typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH
  >;
  [ProvingRequestType.SINGLE_TX_BLOCK_ROOT_ROLLUP]: PublicInputsAndRecursiveProof<
    BlockRootOrBlockMergePublicInputs,
    typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH
  >;
  [ProvingRequestType.BLOCK_ROOT_ROLLUP]: PublicInputsAndRecursiveProof<
    BlockRootOrBlockMergePublicInputs,
    typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH
  >;
  [ProvingRequestType.BLOCK_MERGE_ROLLUP]: PublicInputsAndRecursiveProof<
    BlockRootOrBlockMergePublicInputs,
    typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH
  >;
  [ProvingRequestType.ROOT_ROLLUP]: PublicInputsAndRecursiveProof<RootRollupPublicInputs>;
  [ProvingRequestType.BASE_PARITY]: PublicInputsAndRecursiveProof<ParityPublicInputs, typeof RECURSIVE_PROOF_LENGTH>;
  [ProvingRequestType.ROOT_PARITY]: PublicInputsAndRecursiveProof<
    ParityPublicInputs,
    typeof NESTED_RECURSIVE_PROOF_LENGTH
  >;
  [ProvingRequestType.TUBE_PROOF]: ProofAndVerificationKey<typeof TUBE_PROOF_LENGTH>;
};

export type ProvingRequestResultFor<T extends ProvingRequestType> = { type: T; result: ProvingJobResultsMap[T] };

export const ProvingJobId = z.string();

export const ProofUri = z.string().brand('ProvingJobUri');
export type ProofUri = z.infer<typeof ProofUri>;

export type ProvingJobId = z.infer<typeof ProvingJobId>;
export const ProvingJob = z.object({
  id: ProvingJobId,
  type: z.nativeEnum(ProvingRequestType),
  epochNumber: z.number(),
  inputsUri: ProofUri,
});

export const makeProvingJobId = (epochNumber: number, type: ProvingRequestType, inputsHash: string) => {
  return `${epochNumber}:${ProvingRequestType[type]}:${inputsHash}`;
};

export const getEpochFromProvingJobId = (id: ProvingJobId) => {
  const components = id.split(':');
  const epochNumber = components.length < 1 ? Number.NaN : parseInt(components[0], 10);
  if (!Number.isSafeInteger(epochNumber) || epochNumber < 0) {
    throw new Error(`Proving Job ID ${id} does not contain valid epoch`);
  }
  return epochNumber;
};

export type ProvingJob = z.infer<typeof ProvingJob>;

export function makeProvingRequestResult(
  type: ProvingRequestType,
  result: ProvingJobResult['result'],
): ProvingJobResult {
  return { type, result } as ProvingJobResult;
}

export const ProvingJobFulfilledResult = z.object({
  status: z.literal('fulfilled'),
  value: ProofUri,
});
export type ProvingJobFulfilledResult = z.infer<typeof ProvingJobFulfilledResult>;

export const ProvingJobRejectedResult = z.object({
  status: z.literal('rejected'),
  reason: z.string(),
});
export type ProvingJobRejectedResult = z.infer<typeof ProvingJobRejectedResult>;

export const ProvingJobSettledResult = z.discriminatedUnion('status', [
  ProvingJobFulfilledResult,
  ProvingJobRejectedResult,
]);
export type ProvingJobSettledResult = z.infer<typeof ProvingJobSettledResult>;

export const ProvingJobStatus = z.discriminatedUnion('status', [
  z.object({ status: z.literal('in-queue') }),
  z.object({ status: z.literal('in-progress') }),
  z.object({ status: z.literal('not-found') }),
  ProvingJobFulfilledResult,
  ProvingJobRejectedResult,
]);
export type ProvingJobStatus = z.infer<typeof ProvingJobStatus>;
