import { createHash } from 'crypto'
import { providers } from 'ethers'

import { Bytes } from '../../utils/Bytes'
import { ChainId } from '../../utils/ChainId'
import { EthereumAddress } from '../../utils/EthereumAddress'
import { EtherscanLikeClient } from '../../utils/EtherscanLikeClient'
import { Hash256 } from '../../utils/Hash256'
import { DiscoveryLogger } from '../DiscoveryLogger'
import { isRevert } from '../utils/isRevert'
import { ContractMetadata, DiscoveryProvider } from './DiscoveryProvider'
import { ProviderCache } from './ProviderCache'

const identity = <T>(x: T): T => x

export class ProviderWithCache extends DiscoveryProvider {
  private readonly cache: ProviderCache

  constructor(
    provider: providers.Provider,
    etherscanClient: EtherscanLikeClient,
    logger: DiscoveryLogger,
    chainId: ChainId,
    getLogsMaxRange?: number,
  ) {
    super(provider, etherscanClient, logger, getLogsMaxRange)
    this.cache = new ProviderCache(chainId)
  }

  private async cacheOrFetch<R, S>(
    filename: string,
    key: string,
    fetch: () => Promise<R>,
    toCache: (value: R) => S,
    fromCache: (value: S) => R,
  ): Promise<R> {
    const known = this.cache.get(filename, key)
    if (known !== undefined) {
      return fromCache(known as S)
    }

    const result = await fetch()
    this.cache.set(filename, key, toCache(result))

    return result
  }

  override async call(
    address: EthereumAddress,
    data: Bytes,
    blockNumber: number,
  ): Promise<Bytes> {
    const result = await this.cacheOrFetch(
      `blocks/${blockNumber}`,
      `call.${address.toString()}.${data.toString()}`,
      async () => {
        try {
          return {
            value: (await super.call(address, data, blockNumber)).toString(),
          }
        } catch (e) {
          if (isRevert(e)) {
            return { error: 'revert' }
          } else {
            throw e
          }
        }
      },
      identity,
      identity,
    )
    if (result.value !== undefined) {
      return Bytes.fromHex(result.value)
    } else {
      throw new Error(result.error)
    }
  }

  override async getStorage(
    address: EthereumAddress,
    slot: number | Bytes,
    blockNumber: number,
  ): Promise<Bytes> {
    return this.cacheOrFetch(
      `blocks/${blockNumber}`,
      `getStorage.${address.toString()}.${slot.toString()}`,
      () => super.getStorage(address, slot, blockNumber),
      (result) => result.toString(),
      (cached) => Bytes.fromHex(cached),
    )
  }

  override async getLogsBatch(
    address: EthereumAddress,
    topics: string[][],
    fromBlock: number,
    toBlock: number,
  ): Promise<providers.Log[]> {
    const topicsHash: string = createHash('sha256')
      .update(JSON.stringify(topics))
      .digest('hex')

    return this.cacheOrFetch(
      `logs/${address.toString()}`,
      `getLogs.${fromBlock}.${toBlock}.${topicsHash}`,
      () => super.getLogsBatch(address, topics, fromBlock, toBlock),
      identity,
      identity,
    )
  }

  override async getCode(
    address: EthereumAddress,
    blockNumber: number,
  ): Promise<Bytes> {
    return this.cacheOrFetch(
      `blocks/${blockNumber}`,
      `getCode.${address.toString()}`,
      () => super.getCode(address, blockNumber),
      (result) => result.toString(),
      (cached) => Bytes.fromHex(cached),
    )
  }

  override async getTransaction(
    hash: Hash256,
  ): Promise<providers.TransactionResponse> {
    return this.cacheOrFetch(
      `transactions/${hash.toString()}}`,
      `getTransaction`,
      () => super.getTransaction(hash),
      identity,
      identity,
    )
  }

  override async getMetadata(
    address: EthereumAddress,
  ): Promise<ContractMetadata> {
    return this.cacheOrFetch(
      `addresses/${address.toString()}}`,
      `getMetadata`,
      () => super.getMetadata(address),
      identity,
      identity,
    )
  }
}
