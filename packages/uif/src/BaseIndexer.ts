import { assert } from 'node:console'

import { Logger } from '@l2beat/backend-tools'

import { assertUnreachable } from './assertUnreachable'
import { Indexer, Subscription } from './Indexer'
import { IndexerAction } from './IndexerAction'
import {
  InvalidateEffect,
  NotifyReadyEffect,
  SetSafeHeightEffect,
  UpdateEffect,
} from './IndexerEffect'
import { getInitialState, indexerReducer } from './indexerReducer'
import { IndexerState } from './IndexerState'

export abstract class BaseIndexer implements Indexer {
  private children: Indexer[] = []

  /**
   * Should read the height from the database. It must return a height, so
   * if database is empty a fallback value has to be chosen.
   */
  abstract getSafeHeight(): Promise<number>

  /**
   * Should write the height to the database. The height given is the most
   * pessimistic value and the indexer is expected to actually operate at a
   * higher height in runtime.
   */
  abstract setSafeHeight(height: number): Promise<void>

  /**
   * @param from - inclusive
   * @param to - inclusive
   */
  abstract update(from: number, to: number): Promise<number>

  /**
   * @param to - every value > `to` is invalid, but `to` itself is valid
   */
  abstract invalidate(to: number): Promise<void>

  private state: IndexerState

  constructor(protected logger: Logger, public readonly parents: Indexer[]) {
    this.logger = this.logger.for(this)
    this.state = getInitialState(parents.length)
    this.parents.forEach((parent) => {
      this.logger.debug('Subscribing to parent', {
        parent: parent.constructor.name,
      })
      parent.subscribe(this)
    })
  }

  async start(): Promise<void> {
    const height = await this.getSafeHeight()
    this.dispatch({
      type: 'Initialized',
      height,
      childCount: this.children.length,
    })
  }

  subscribe(child: Indexer): Subscription {
    this.logger.debug('Child subscribed', { child: child.constructor.name })
    this.children.push(child)
    this.dispatch({ type: 'ChildSubscribed' })
    return {
      unsubscribe: (): void => {
        const index = this.children.indexOf(child)
        assert(index !== -1, 'Received unsubscribe from unknown child')

        this.logger.debug('Child unsubscribed', {
          child: child.constructor.name,
        })
        this.children = this.children.filter((c) => c !== child)
        this.dispatch({ type: 'ChildUnsubscribed', index })
      },
    }
  }

  notifyReady(child: Indexer): void {
    this.logger.debug('Someone is ready', { child: child.constructor.name })
    const index = this.children.indexOf(child)
    assert(index !== -1, 'Received ready from unknown child')
    this.dispatch({ type: 'ChildReady', index })
  }

  notifyUpdate(parent: Indexer, to: number): void {
    const index = this.parents.indexOf(parent)
    assert(index !== -1, 'Received update from unknown parent')
    this.dispatch({ type: 'ParentUpdated', index, to })
  }

  getState(): IndexerState {
    return this.state
  }

  private dispatch(action: IndexerAction): void {
    const [newState, effects] = indexerReducer(this.state, action)
    this.state = newState
    this.logger.debug('Dispatched', { action, newState: this.state, effects })

    // TODO: check if this doesn't result in stack overflow
    effects.forEach((effect) => {
      switch (effect.type) {
        case 'Update':
          return void this.executeUpdate(effect)
        case 'Invalidate':
          return void this.executeInvalidate(effect)
        case 'SetSafeHeight':
          return void this.executeSetSafeHeight(effect)
        case 'NotifyReady':
          return this.executeNotifyReady(effect)
        default:
          return assertUnreachable(effect)
      }
    })
  }

  private async executeUpdate(effect: UpdateEffect): Promise<void> {
    const from = this.state.height
    try {
      const to = await this.update(from, effect.to)
      if (to < from || to > effect.to) {
        this.logger.error('Update returned invalid height', {
          returned: to,
          min: from,
          max: effect.to,
        })
        this.dispatch({ type: 'UpdateFailed', from, to: effect.to })
      } else {
        this.dispatch({ type: 'UpdateSucceeded', from, to })
      }
    } catch (e) {
      this.logger.error('Update failed', e)
      this.dispatch({ type: 'UpdateFailed', from, to: effect.to })
    }
  }

  private async executeInvalidate(effect: InvalidateEffect): Promise<void> {
    try {
      await this.invalidate(effect.to)
      this.dispatch({ type: 'InvalidateSucceeded', to: effect.to })
    } catch (e) {
      this.logger.error('Invalidate failed', e)
      this.dispatch({ type: 'InvalidateFailed', to: effect.to })
    }
  }

  private async executeSetSafeHeight(
    effect: SetSafeHeightEffect,
  ): Promise<void> {
    await this.setSafeHeight(effect.safeHeight)
    this.children.forEach((child) =>
      child.notifyUpdate(this, effect.safeHeight),
    )
  }

  private executeNotifyReady(effect: NotifyReadyEffect): void {
    this.parents.forEach((parent, index) => {
      if (effect.parentIndices.includes(index)) {
        parent.notifyReady(this)
      }
    })
  }
}
