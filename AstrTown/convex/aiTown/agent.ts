import { ObjectType, v } from 'convex/values';
import { GameId, parseGameId } from './ids';
import { agentId, conversationId, playerId } from './ids';
import { Activity, Player } from './player';
import { Game } from './game';
import {
  ACTION_TIMEOUT,
  AWKWARD_CONVERSATION_TIMEOUT,
  CONVERSATION_DISTANCE,
  EXTERNAL_QUEUE_LEAVE_THRESHOLD,
  EXTERNAL_QUEUE_LOW_WATERMARK,
  EXTERNAL_QUEUE_PREFETCH_MIN_INTERVAL,
  EXTERNAL_QUEUE_PREFETCH_TIMEOUT,
  EXTERNAL_QUEUE_SLEEP_WINDOW,
  INVITE_TIMEOUT,
  MIDPOINT_THRESHOLD,
  WANDER_DURATION,
  WANDER_MAP_MARGIN,
  WANDER_STEP_INTERVAL,
} from '../constants';
import { FunctionArgs } from 'convex/server';
import { MutationCtx } from '../_generated/server';
import { distance } from '../util/geometry';
import { internal } from '../_generated/api';
import { blockedWithPositions, movePlayer, stopPlayer } from './movement';

type ExternalEventArgs = Record<string, unknown>;

type GridPoint = {
  x: number;
  y: number;
};

function isRecord(value: unknown): value is ExternalEventArgs {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function asPoint(value: unknown): GridPoint | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const x = asNumber(value.x);
  const y = asNumber(value.y);
  if (x === undefined || y === undefined) {
    return undefined;
  }
  return { x, y };
}

export type ExternalEventItem = {
  eventId: string;
  kind:
    | 'move_to'
    | 'say'
    | 'emote'
    | 'start_conversation'
    | 'accept_invite'
    | 'reject_invite'
    | 'leave_conversation'
    | 'continue_doing'
    | 'do_something';
  args: ExternalEventArgs;
  priority: 0 | 1 | 2 | 3;
  enqueueTs: number;
  expiresAt?: number;
  source: 'gateway' | 'system_interrupt';
};

export type ExternalQueueState = {
  lastDequeuedAt?: number;
  prefetch: {
    requestedAt?: number;
    requestId?: string;
    dispatched?: boolean;
    retries: number;
    waiting: boolean;
  };
  idle: {
    mode: 'active' | 'sleeping' | 'leaving' | 'roaming';
    sleepingSince?: number;
    roamingStartedAt?: number;
    roamingUntilAt?: number;
    lastRoamMoveAt?: number;
    consecutivePrefetchMisses: number;
  };
};

export function createDefaultExternalQueueState(): ExternalQueueState {
  return {
    prefetch: {
      dispatched: false,
      retries: 0,
      waiting: false,
    },
    idle: {
      mode: 'active',
      consecutivePrefetchMisses: 0,
    },
  };
}

function normalizeExternalQueueState(state: ExternalQueueState | undefined): ExternalQueueState {
  if (!state) {
    return createDefaultExternalQueueState();
  }
  return {
    lastDequeuedAt: state.lastDequeuedAt,
    prefetch: {
      requestedAt: state.prefetch.requestedAt,
      requestId: state.prefetch.requestId,
      dispatched: state.prefetch.dispatched ?? false,
      retries: state.prefetch.retries,
      waiting: state.prefetch.waiting,
    },
    idle: {
      mode: state.idle.mode,
      sleepingSince: state.idle.sleepingSince,
      roamingStartedAt: state.idle.roamingStartedAt,
      roamingUntilAt: state.idle.roamingUntilAt,
      lastRoamMoveAt: state.idle.lastRoamMoveAt,
      consecutivePrefetchMisses: state.idle.consecutivePrefetchMisses,
    },
  };
}

function toExternalEventItem(
  item: Omit<ExternalEventItem, 'args'> & { args: unknown },
): ExternalEventItem {
  return {
    eventId: item.eventId,
    kind: item.kind,
    args: isRecord(item.args) ? item.args : {},
    priority: item.priority,
    enqueueTs: item.enqueueTs,
    expiresAt: item.expiresAt,
    source: item.source,
  };
}

export class Agent {
  id: GameId<'agents'>;
  playerId: GameId<'players'>;
  toRemember?: GameId<'conversations'>;
  lastConversation?: number;
  lastInviteAttempt?: number;
  inProgressOperation?: {
    name: string;
    operationId: string;
    started: number;
  };
  externalEventQueue: ExternalEventItem[];
  externalPriorityQueue: ExternalEventItem[];
  externalQueueState: ExternalQueueState;

  constructor(serialized: SerializedAgent) {
    const {
      id,
      lastConversation,
      lastInviteAttempt,
      inProgressOperation,
      externalEventQueue,
      externalPriorityQueue,
      externalQueueState,
    } = serialized;
    const playerId = parseGameId('players', serialized.playerId);
    this.id = parseGameId('agents', id);
    this.playerId = playerId;
    this.toRemember =
      serialized.toRemember !== undefined
        ? parseGameId('conversations', serialized.toRemember)
        : undefined;
    this.lastConversation = lastConversation;
    this.lastInviteAttempt = lastInviteAttempt;
    this.inProgressOperation = inProgressOperation;
    this.externalEventQueue =
      externalEventQueue?.map((item) => toExternalEventItem(item)) ?? [];
    this.externalPriorityQueue =
      externalPriorityQueue?.map((item) => toExternalEventItem(item)) ?? [];
    this.externalQueueState = normalizeExternalQueueState(externalQueueState);
  }

  private dequeueExternalFromQueue(
    queue: ExternalEventItem[],
    now: number,
    allowedKinds?: ReadonlyArray<ExternalEventItem['kind']>,
  ): { item?: ExternalEventItem; expiredDrops: ExternalEventItem[] } {
    const expiredDrops: ExternalEventItem[] = [];
    while (queue.length > 0) {
      const index =
        allowedKinds && allowedKinds.length > 0
          ? queue.findIndex((item) => allowedKinds.includes(item.kind))
          : 0;
      if (index === -1) {
        return { item: undefined, expiredDrops };
      }
      const [event] = queue.splice(index, 1);
      if (event.expiresAt !== undefined && event.expiresAt <= now) {
        console.log(`[ExternalControl] Dropping expired event ${event.eventId} (${event.kind})`);
        expiredDrops.push(event);
        continue;
      }
      return { item: event, expiredDrops };
    }
    return { item: undefined, expiredDrops };
  }

  private onExternalEventDequeued(now: number) {
    this.externalQueueState.lastDequeuedAt = now;
    this.externalQueueState.prefetch.waiting = false;
    this.externalQueueState.prefetch.dispatched = false;
    this.externalQueueState.prefetch.retries = 0;
    this.externalQueueState.idle.mode = 'active';
    delete this.externalQueueState.idle.sleepingSince;
    delete this.externalQueueState.idle.roamingStartedAt;
    delete this.externalQueueState.idle.roamingUntilAt;
    delete this.externalQueueState.idle.lastRoamMoveAt;
    this.externalQueueState.idle.consecutivePrefetchMisses = 0;
  }

  private normalizeActivityFromEvent(now: number, args: ExternalEventArgs): Activity | undefined {
    const nestedActivity = isRecord(args.activity) ? args.activity : undefined;
    if (nestedActivity) {
      const description = asString(nestedActivity.description);
      const until = asNumber(nestedActivity.until);
      if (description !== undefined && until !== undefined) {
        return {
          description,
          emoji: asString(nestedActivity.emoji),
          until,
          started: asNumber(nestedActivity.started) ?? now,
        };
      }
    }

    const description = asString(args.description);
    const until = asNumber(args.until);
    if (description !== undefined && until !== undefined) {
      return {
        description,
        emoji: asString(args.emoji),
        until,
        started: now,
      };
    }

    const duration = asNumber(args.duration);
    if (description !== undefined && duration !== undefined) {
      return {
        description,
        emoji: asString(args.emoji),
        until: now + duration,
        started: now,
      };
    }

    return undefined;
  }

  private nearestMapEdgePoint(player: Player, mapWidth: number, mapHeight: number) {
    const maxX = Math.max(0, mapWidth - 1);
    const maxY = Math.max(0, mapHeight - 1);
    const current = {
      x: Math.max(0, Math.min(maxX, Math.floor(player.position.x))),
      y: Math.max(0, Math.min(maxY, Math.floor(player.position.y))),
    };
    const candidates = [
      { x: 0, y: current.y },
      { x: maxX, y: current.y },
      { x: current.x, y: 0 },
      { x: current.x, y: maxY },
    ];
    let best = candidates[0];
    let bestDistance = distance(current, best);
    for (const candidate of candidates.slice(1)) {
      const candidateDistance = distance(current, candidate);
      if (candidateDistance < bestDistance) {
        best = candidate;
        bestDistance = candidateDistance;
      }
    }
    return best;
  }

  private isPlayerAtMapEdge(player: Player, mapWidth: number, mapHeight: number) {
    const x = Math.floor(player.position.x);
    const y = Math.floor(player.position.y);
    return x <= 0 || y <= 0 || x >= mapWidth - 1 || y >= mapHeight - 1;
  }

  private pickRandomWanderTarget(game: Game, player: Player): { x: number; y: number } | null {
    const { width, height } = game.worldMap;
    if (width <= 0 || height <= 0) {
      return null;
    }

    const maxMarginX = Math.floor((width - 1) / 2);
    const maxMarginY = Math.floor((height - 1) / 2);
    const margin = Math.max(0, Math.min(WANDER_MAP_MARGIN, maxMarginX, maxMarginY));

    const minX = margin;
    const maxX = width - margin - 1;
    const minY = margin;
    const maxY = height - margin - 1;
    if (minX > maxX || minY > maxY) {
      return null;
    }

    const otherPositions = [...game.world.players.values()]
      .filter((p) => p.id !== player.id)
      .map((p) => p.position);

    const maxAttempts = 10;
    for (let i = 0; i < maxAttempts; i++) {
      const x = minX + Math.floor(Math.random() * (maxX - minX + 1));
      const y = minY + Math.floor(Math.random() * (maxY - minY + 1));
      const position = { x, y };
      if (blockedWithPositions(position, otherPositions, game.worldMap) === null) {
        return position;
      }
    }

    return null;
  }

  private enterSleepingMode(now: number, player: Player) {
    this.externalQueueState.idle.mode = 'sleeping';
    this.externalQueueState.idle.sleepingSince = now;
    delete this.externalQueueState.idle.roamingStartedAt;
    delete this.externalQueueState.idle.roamingUntilAt;
    delete this.externalQueueState.idle.lastRoamMoveAt;
    player.activity = {
      description: 'idle',
      emoji: '😴',
      until: now + EXTERNAL_QUEUE_SLEEP_WINDOW,
      started: now,
    };
  }

  private enterLeavingMode(game: Game, now: number, player: Player) {
    this.externalQueueState.idle.mode = 'leaving';
    delete this.externalQueueState.idle.sleepingSince;
    delete this.externalQueueState.idle.roamingStartedAt;
    delete this.externalQueueState.idle.roamingUntilAt;
    delete this.externalQueueState.idle.lastRoamMoveAt;
    const destination = this.nearestMapEdgePoint(player, game.worldMap.width, game.worldMap.height);
    try {
      movePlayer(game, now, player, destination);
    } catch (error) {
      console.warn(`[ExternalControl] Failed to start leaving path for ${this.id}`,
      error);
      this.externalEventQueue = [];
      this.externalPriorityQueue = [];
      this.externalQueueState = createDefaultExternalQueueState();
    }
  }
  private continueLeavingMode(game: Game, now: number, player: Player) {
    if (this.isPlayerAtMapEdge(player, game.worldMap.width, game.worldMap.height)) {
      this.externalEventQueue = [];
      this.externalPriorityQueue = [];
      this.externalQueueState = createDefaultExternalQueueState();
      return;
    }
    if (player.pathfinding) {
      return;
    }
    const destination = this.nearestMapEdgePoint(player, game.worldMap.width, game.worldMap.height);
    try {
      movePlayer(game, now, player, destination);
    } catch (error) {
      console.warn(`[ExternalControl] Failed to continue leaving path for ${this.id}`,
      error);
      this.externalEventQueue = [];
      this.externalPriorityQueue = [];
      this.externalQueueState = createDefaultExternalQueueState();
    }
  }

  private enterRoamingMode(game: Game, now: number, player: Player) {
    this.externalQueueState.idle.mode = 'roaming';
    delete this.externalQueueState.idle.sleepingSince;
    this.externalQueueState.idle.roamingStartedAt = now;
    this.externalQueueState.idle.roamingUntilAt = now + WANDER_DURATION;
    this.externalQueueState.idle.lastRoamMoveAt = now;

    const target = this.pickRandomWanderTarget(game, player);
    if (!target) {
      return;
    }

    try {
      movePlayer(game, now, player, target);
    } catch (error) {
      console.warn(`[ExternalControl] Failed to start roaming path for ${this.id}`, error);
    }
  }

  private continueRoamingMode(game: Game, now: number, player: Player) {
    if (this.externalQueueState.idle.roamingUntilAt === undefined) {
      this.externalQueueState.idle.roamingStartedAt ??= now;
      this.externalQueueState.idle.roamingUntilAt = now + WANDER_DURATION;
    }

    if (now >= this.externalQueueState.idle.roamingUntilAt) {
      this.externalQueueState.idle.mode = 'active';
      delete this.externalQueueState.idle.roamingStartedAt;
      delete this.externalQueueState.idle.roamingUntilAt;
      delete this.externalQueueState.idle.lastRoamMoveAt;
      this.externalQueueState.idle.consecutivePrefetchMisses = 0;
      stopPlayer(player);
      return;
    }

    if (player.pathfinding !== undefined) {
      return;
    }

    const lastMoveAt = this.externalQueueState.idle.lastRoamMoveAt ?? 0;
    if (now - lastMoveAt < WANDER_STEP_INTERVAL) {
      return;
    }

    this.externalQueueState.idle.lastRoamMoveAt = now;
    const target = this.pickRandomWanderTarget(game, player);
    if (!target) {
      return;
    }

    try {
      movePlayer(game, now, player, target);
    } catch (error) {
      console.warn(`[ExternalControl] Failed to continue roaming path for ${this.id}`, error);
    }
  }

  private executeExternalEvent(game: Game, now: number, event: ExternalEventItem) {
    const player = game.world.players.get(this.playerId);
    if (!player) {
      throw new Error(`Invalid player ID ${this.playerId}`);
    }

    switch (event.kind) {
      case 'move_to': {
        let destination = asPoint(event.args.destination);
        const targetPlayerId = asString(event.args.targetPlayerId);
        if (!destination && targetPlayerId) {
          const parsedTargetPlayerId = parseGameId('players', targetPlayerId);
          const targetPlayer = game.world.players.get(parsedTargetPlayerId);
          if (!targetPlayer) {
            throw new Error(`Couldn't find player: ${parsedTargetPlayerId}`);
          }
          destination = {
            x: Math.floor(targetPlayer.position.x),
            y: Math.floor(targetPlayer.position.y),
          };
        }
        if (!destination) {
          throw new Error(`Invalid destination for move_to: ${JSON.stringify(event.args)}`);
        }
        movePlayer(game, now, player, {
          x: Math.floor(destination.x),
          y: Math.floor(destination.y),
        });
        return;
      }
      case 'say': {
        const conversationIdRaw = asString(event.args.conversationId);
        if (!conversationIdRaw) {
          throw new Error(`Missing conversationId for say: ${JSON.stringify(event.args)}`);
        }
        game.handleInput(now, 'externalBotSendMessage', {
          agentId: this.id,
          conversationId: conversationIdRaw,
          text: asString(event.args.text),
          timestamp: asNumber(event.args.timestamp) ?? now,
          leaveConversation: Boolean(event.args.leaveAfter || event.args.leaveConversation),
        });
        return;
      }
      case 'emote': {
        const emoteActivity = this.normalizeActivityFromEvent(now, event.args);
        if (!emoteActivity) {
          throw new Error(`Invalid emote payload: ${JSON.stringify(event.args)}`);
        }
        player.activity = emoteActivity;
        return;
      }
      case 'start_conversation': {
        const inviteeRaw = asString(event.args.invitee) ?? asString(event.args.targetPlayerId);
        if (!inviteeRaw) {
          throw new Error(`Missing invitee for start_conversation: ${JSON.stringify(event.args)}`);
        }
        game.handleInput(now, 'startConversation', {
          playerId: this.playerId,
          invitee: inviteeRaw,
        });
        this.lastInviteAttempt = now;
        return;
      }
      case 'accept_invite': {
        const conversationIdRaw =
          asString(event.args.conversationId) ?? game.world.playerConversation(player)?.id;
        if (!conversationIdRaw) {
          throw new Error(`Missing conversationId for accept_invite: ${JSON.stringify(event.args)}`);
        }
        game.handleInput(now, 'acceptInvite', {
          playerId: this.playerId,
          conversationId: conversationIdRaw,
        });
        if (player.pathfinding) {
          delete player.pathfinding;
        }
        game.pendingOperations.push({
          name: 'agentStateChangedInConversation',
          args: {
            agentId: this.id,
            worldId: game.worldId,
          },
        });
        return;
      }
      case 'reject_invite': {
        const conversationIdRaw =
          asString(event.args.conversationId) ?? game.world.playerConversation(player)?.id;
        if (!conversationIdRaw) {
          throw new Error(`Missing conversationId for reject_invite: ${JSON.stringify(event.args)}`);
        }
        game.handleInput(now, 'rejectInvite', {
          playerId: this.playerId,
          conversationId: conversationIdRaw,
        });
        return;
      }
      case 'leave_conversation': {
        const conversationIdRaw =
          asString(event.args.conversationId) ?? game.world.playerConversation(player)?.id;
        if (!conversationIdRaw) {
          throw new Error(`Missing conversationId for leave_conversation: ${JSON.stringify(event.args)}`);
        }
        game.handleInput(now, 'leaveConversation', {
          playerId: this.playerId,
          conversationId: conversationIdRaw,
        });
        return;
      }
      case 'continue_doing': {
        const activity = this.normalizeActivityFromEvent(now, event.args);
        if (!activity) {
          throw new Error(`Missing activity for continue_doing: ${JSON.stringify(event.args)}`);
        }
        player.activity = activity;
        return;
      }
      case 'do_something': {
        const actionType = asString(event.args.actionType);
        if (actionType) {
          switch (actionType) {
            case 'move_to': {
              this.executeExternalEvent(game, now, {
                ...event,
                kind: 'move_to',
                args: {
                  destination: event.args.destination,
                },
              });
              return;
            }
            case 'invite': {
              this.executeExternalEvent(game, now, {
                ...event,
                kind: 'start_conversation',
                args: {
                  invitee: asString(event.args.invitee) ?? asString(event.args.targetPlayerId),
                },
              });
              return;
            }
            case 'say': {
              this.executeExternalEvent(game, now, {
                ...event,
                kind: 'say',
                args: {
                  ...event.args,
                  text: asString(event.args.content) ?? asString(event.args.text),
                },
              });
              return;
            }
            case 'accept_invite': {
              this.executeExternalEvent(game, now, {
                ...event,
                kind: 'accept_invite',
                args: {
                  conversationId: event.args.conversationId,
                },
              });
              return;
            }
            case 'leave_conversation': {
              this.executeExternalEvent(game, now, {
                ...event,
                kind: 'leave_conversation',
                args: {
                  conversationId: event.args.conversationId,
                },
              });
              return;
            }
            case 'set_activity': {
              this.executeExternalEvent(game, now, {
                ...event,
                kind: 'continue_doing',
                args: {
                  ...event.args,
                },
              });
              return;
            }
            default: {
              throw new Error(`Unknown actionType for do_something: ${actionType}`);
            }
          }
        }

        // 兼容旧结构：当 actionType 缺失时，沿用历史字段猜测逻辑。
        const inviteeRaw = asString(event.args.invitee);
        if (inviteeRaw) {
          game.handleInput(now, 'startConversation', {
            playerId: this.playerId,
            invitee: inviteeRaw,
          });
          this.lastInviteAttempt = now;
        }
        const destination = asPoint(event.args.destination);
        if (destination) {
          movePlayer(game, now, player, {
            x: Math.floor(destination.x),
            y: Math.floor(destination.y),
          });
        }
        const activity = this.normalizeActivityFromEvent(now, event.args);
        if (activity) {
          player.activity = activity;
        }
        return;
      }
    }
  }

  tick(game: Game, now: number) {
    // ===== 1. inProgressOperation 超时处理 =====
    if (this.inProgressOperation) {
      if (now < this.inProgressOperation.started + ACTION_TIMEOUT) {
        return; // 等待操作完成
      }
      console.log(`[ExternalControl] Timing out ${JSON.stringify(this.inProgressOperation)}`);
      delete this.inProgressOperation;

      game.pendingOperations.push({
        name: 'agentStateChangedIdle',
        args: {
          agentId: this.id,
          worldId: game.worldId,
        },
      });
    }

    // 获取 player 和 conversation 上下文
    const player = game.world.players.get(this.playerId);
    if (!player) {
      throw new Error(`Invalid player ID ${this.playerId}`);
    }

    const conversation = game.world.playerConversation(player);
    const member = conversation?.participants.get(player.id);

    // ===== 2. toRemember 记忆处理 (自动执行) =====
    if (this.toRemember) {
      console.log(`[ExternalControl] Agent ${this.id} remembering conversation ${this.toRemember}`);
      this.startOperation(game, now, 'agentRememberConversation', {
        worldId: game.worldId,
        playerId: this.playerId,
        agentId: this.id,
        conversationId: this.toRemember,
      });
      delete this.toRemember;
      return;
    }

    // ===== 3. walkingOver 状态移动逻辑 =====
    if (conversation && member && member.status.kind === 'walkingOver') {
      const [otherPlayerId] = [...conversation.participants.entries()].find(([id]) => id !== player.id)!;
      const otherPlayer = game.world.players.get(otherPlayerId)!;

      // Invite timeout 检查
      if (member.invited + INVITE_TIMEOUT < now) {
        console.log(`[ExternalControl] Giving up on invite to ${otherPlayer.id}`);
        conversation.leave(game, now, player);
        return;
      }

      const playerDistance = distance(player.position, otherPlayer.position);
      if (playerDistance < CONVERSATION_DISTANCE) {
        return; // 已经够近，等待 Conversation.tick 转换状态
      }

      // 自动寻路移动
      if (!player.pathfinding) {
        let destination;
        if (playerDistance < MIDPOINT_THRESHOLD) {
          destination = {
            x: Math.floor(otherPlayer.position.x),
            y: Math.floor(otherPlayer.position.y),
          };
        } else {
          destination = {
            x: Math.floor((player.position.x + otherPlayer.position.x) / 2),
            y: Math.floor((player.position.y + otherPlayer.position.y) / 2),
          };
        }
        console.log(`[ExternalControl] Agent ${player.id} walking towards ${otherPlayer.id}...`, destination);
        movePlayer(game, now, player, destination);
      }
      return;
    }

    // ===== 4. participating 状态 - 不主动生成消息，等待插件命令 =====
    if (conversation && member && member.status.kind === 'participating') {
      const lastActive = conversation.lastMessage?.timestamp ?? conversation.created;
      if (now > lastActive + AWKWARD_CONVERSATION_TIMEOUT) {
        conversation.leave(game, now, player);
        game.pendingOperations.push({
          name: 'conversation.timeout',
          args: { agentId: this.id, conversationId: conversation.id, reason: 'idle_timeout' },
        });
        return;
      }
      return; // 继续等待外部指令
    }

    // ===== 5. invited 状态：仅处理优先队列里的 accept/reject =====
    if (conversation && member && member.status.kind === 'invited') {
      if (member.invited + INVITE_TIMEOUT < now) {
        conversation.rejectInvite(game, now, player);
        game.pendingOperations.push({
          name: 'conversation.timeout',
          args: {
            agentId: this.id,
            conversationId: conversation.id,
            reason: 'invite_timeout',
          },
        });
        return;
      }

      const { item: inviteEvent, expiredDrops } = this.dequeueExternalFromQueue(
        this.externalPriorityQueue,
        now,
        ['accept_invite', 'reject_invite'],
      );
      for (const drop of expiredDrops) {
        game.pendingOperations.push({
          name: 'action.finished',
          args: {
            agentId: this.id,
            actionType: drop.kind,
            success: false,
            result: { reason: 'expired', eventId: drop.eventId },
          },
        });
      }
      if (!inviteEvent) {
        return;
      }
      this.onExternalEventDequeued(now);
      try {
        this.executeExternalEvent(game, now, inviteEvent);
      } catch (error) {
        console.warn(
          `[ExternalControl] Failed to execute invited event ${inviteEvent.eventId} (${inviteEvent.kind})`,
          error,
        );
      }
      return;
    }

    // ===== 6. 空闲状态：按优先级消费队列 =====
    const { item: priorityEvent, expiredDrops: expiredPriorityDrops } =
      this.dequeueExternalFromQueue(this.externalPriorityQueue, now);
    for (const drop of expiredPriorityDrops) {
      game.pendingOperations.push({
        name: 'action.finished',
        args: {
          agentId: this.id,
          actionType: drop.kind,
          success: false,
          result: { reason: 'expired', eventId: drop.eventId },
        },
      });
    }
    if (priorityEvent) {
      this.onExternalEventDequeued(now);
      try {
        this.executeExternalEvent(game, now, priorityEvent);
      } catch (error) {
        console.warn(
          `[ExternalControl] Failed to execute priority event ${priorityEvent.eventId} (${priorityEvent.kind})`,
          error,
        );
      }
      return;
    }

    const { item: normalEvent, expiredDrops: expiredNormalDrops } = this.dequeueExternalFromQueue(
      this.externalEventQueue,
      now,
    );
    for (const drop of expiredNormalDrops) {
      game.pendingOperations.push({
        name: 'action.finished',
        args: {
          agentId: this.id,
          actionType: drop.kind,
          success: false,
          result: { reason: 'expired', eventId: drop.eventId },
        },
      });
    }
    if (normalEvent) {
      this.onExternalEventDequeued(now);
      try {
        this.executeExternalEvent(game, now, normalEvent);
      } catch (error) {
        console.warn(
          `[ExternalControl] Failed to execute event ${normalEvent.eventId} (${normalEvent.kind})`,
          error,
        );
      }
      return;
    }

    // ===== 7. 队列为空：处理 leaving / roaming / prefetch / sleeping =====
    if (this.externalQueueState.idle.mode === 'leaving') {
      this.continueLeavingMode(game, now, player);
      return;
    }
    if (this.externalQueueState.idle.mode === 'roaming') {
      this.continueRoamingMode(game, now, player);
      return;
    }

    if (this.externalQueueState.prefetch.waiting) {
      if (this.externalQueueState.prefetch.requestedAt === undefined) {
        this.externalQueueState.prefetch.requestedAt = now;
        if (!this.externalQueueState.prefetch.requestId) {
          this.externalQueueState.prefetch.requestId = `${this.id}:${now}`;
        }
        this.externalQueueState.prefetch.dispatched = false;
      } else if (now - this.externalQueueState.prefetch.requestedAt > EXTERNAL_QUEUE_PREFETCH_TIMEOUT) {
        this.externalQueueState.prefetch.waiting = false;
        this.externalQueueState.prefetch.dispatched = false;
        this.externalQueueState.prefetch.retries += 1;
        this.externalQueueState.idle.consecutivePrefetchMisses += 1;

        if (this.externalQueueState.idle.consecutivePrefetchMisses >= EXTERNAL_QUEUE_LEAVE_THRESHOLD) {
          this.enterRoamingMode(game, now, player);
        } else {
          this.enterSleepingMode(now, player);
        }
      }
      return;
    }

    const queueDepth = this.externalPriorityQueue.length + this.externalEventQueue.length;
    if (queueDepth <= EXTERNAL_QUEUE_LOW_WATERMARK) {
      const lastRequestAt = this.externalQueueState.prefetch.requestedAt;
      if (lastRequestAt === undefined || now - lastRequestAt >= EXTERNAL_QUEUE_PREFETCH_MIN_INTERVAL) {
        this.externalQueueState.prefetch.waiting = true;
        this.externalQueueState.prefetch.requestedAt = now;
        this.externalQueueState.prefetch.requestId = `${this.id}:${now}`;
        this.externalQueueState.prefetch.dispatched = false;
      }
    }

    return;
  }

  startOperation<Name extends Extract<keyof AgentOperations, string>>(
    game: Game,
    now: number,
    name: Name,
    args: Omit<FunctionArgs<AgentOperations[Name]>, 'operationId'>,
  ) {
    if (this.inProgressOperation) {
      throw new Error(
        `Agent ${this.id} already has an operation: ${JSON.stringify(this.inProgressOperation)}`,
      );
    }
    const operationId = game.allocId('operations');
    console.log(`Agent ${this.id} starting operation ${name} (${operationId})`);
    if (name === 'agentRememberConversation') {
      game.scheduleOperation({
        name,
        args: {
          operationId,
          worldId: args.worldId,
          playerId: args.playerId,
          agentId: args.agentId,
          conversationId: args.conversationId,
        },
      });
    }
    this.inProgressOperation = {
      name,
      operationId,
      started: now,
    };
  }

  serialize(): SerializedAgent {
    return {
      id: this.id,
      playerId: this.playerId,
      toRemember: this.toRemember,
      lastConversation: this.lastConversation,
      lastInviteAttempt: this.lastInviteAttempt,
      inProgressOperation: this.inProgressOperation,
      externalEventQueue: this.externalEventQueue,
      externalPriorityQueue: this.externalPriorityQueue,
      externalQueueState: this.externalQueueState,
    };
  }
}

export const externalEventItemValidator = v.object({
  eventId: v.string(),
  kind: v.union(
    v.literal('move_to'),
    v.literal('say'),
    v.literal('emote'),
    v.literal('start_conversation'),
    v.literal('accept_invite'),
    v.literal('reject_invite'),
    v.literal('leave_conversation'),
    v.literal('continue_doing'),
    v.literal('do_something'),
  ),
  args: v.any(),
  priority: v.union(v.literal(0), v.literal(1), v.literal(2), v.literal(3)),
  enqueueTs: v.number(),
  expiresAt: v.optional(v.number()),
  source: v.union(v.literal('gateway'), v.literal('system_interrupt')),
});

export const externalQueueStateValidator = v.object({
  lastDequeuedAt: v.optional(v.number()),
  prefetch: v.object({
    requestedAt: v.optional(v.number()),
    requestId: v.optional(v.string()),
    dispatched: v.optional(v.boolean()),
    retries: v.number(),
    waiting: v.boolean(),
  }),
  idle: v.object({
    mode: v.union(
      v.literal('active'),
      v.literal('sleeping'),
      v.literal('leaving'),
      v.literal('roaming'),
    ),
    sleepingSince: v.optional(v.number()),
    roamingStartedAt: v.optional(v.number()),
    roamingUntilAt: v.optional(v.number()),
    lastRoamMoveAt: v.optional(v.number()),
    consecutivePrefetchMisses: v.number(),
  }),
});

export const serializedAgent = {
  id: agentId,
  playerId: playerId,
  toRemember: v.optional(conversationId),
  lastConversation: v.optional(v.number()),
  lastInviteAttempt: v.optional(v.number()),
  inProgressOperation: v.optional(
    v.object({
      name: v.string(),
      operationId: v.string(),
      started: v.number(),
    }),
  ),
  externalEventQueue: v.optional(v.array(externalEventItemValidator)),
  externalPriorityQueue: v.optional(v.array(externalEventItemValidator)),
  externalQueueState: v.optional(externalQueueStateValidator),
};
export type SerializedAgent = ObjectType<typeof serializedAgent>;

type AgentOperations = typeof internal.aiTown.agentOperations;

export async function runAgentOperation(
  ctx: MutationCtx,
  operation: 'agentRememberConversation',
  args: FunctionArgs<typeof internal.aiTown.agentOperations.agentRememberConversation>,
) {
  switch (operation) {
    case 'agentRememberConversation':
      await ctx.scheduler.runAfter(0, internal.aiTown.agentOperations.agentRememberConversation, args);
      return;
  }
}
