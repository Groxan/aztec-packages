import type { CompleteAddress, NodeInfo } from '@aztec/circuits.js';
import { type ContractArtifact } from '@aztec/circuits.js/abi';
import { getContractInstanceFromDeployParams } from '@aztec/circuits.js/contract';
import { deriveKeys } from '@aztec/circuits.js/keys';
import { Fr } from '@aztec/foundation/fields';

import { type AccountInterface, type AuthWitnessProvider } from './interface.js';

// docs:start:account-contract-interface
/**
 * An account contract instance. Knows its artifact, deployment arguments, how to create
 * transaction execution requests out of function calls, and how to authorize actions.
 */
export interface AccountContract {
  /**
   * Returns the artifact of this account contract.
   */
  getContractArtifact(): ContractArtifact;

  /**
   * Returns the deployment arguments for this instance, or undefined if this contract does not require deployment.
   */
  getDeploymentArgs(): Promise<any[] | undefined>;

  /**
   * Returns the account interface for this account contract given a deployment at the provided address.
   * The account interface is responsible for assembling tx requests given requested function calls, and
   * for creating signed auth witnesses given action identifiers (message hashes).
   * @param address - Address where this account contract is deployed.
   * @param nodeInfo - Info on the chain where it is deployed.
   * @returns An account interface instance for creating tx requests and authorizing actions.
   */
  getInterface(address: CompleteAddress, nodeInfo: NodeInfo): AccountInterface;

  /**
   * Returns the auth witness provider for the given address.
   * @param address - Address for which to create auth witnesses.
   */
  getAuthWitnessProvider(address: CompleteAddress): AuthWitnessProvider;
}
// docs:end:account-contract-interface

/**
 * Compute the address of an account contract from secret and salt.
 */
export async function getAccountContractAddress(accountContract: AccountContract, secret: Fr, salt: Fr) {
  const { publicKeys } = await deriveKeys(secret);
  const constructorArgs = await accountContract.getDeploymentArgs();
  const instance = await getContractInstanceFromDeployParams(accountContract.getContractArtifact(), {
    constructorArgs,
    salt,
    publicKeys,
  });
  return instance.address;
}
