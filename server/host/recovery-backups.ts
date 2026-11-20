import { type RecoveryAttempt, recoveryCapabilityError, refusalsAllow, untriedBackups } from "../automatic-recovery.ts";
import type { InstanceConfigMap, ProviderInstance } from "../contracts.ts";
import type { LimitScope } from "./limit-takeover.ts";
import type { BotRecord, Store } from "../store.ts";
import type { ModelSelection } from "../../shared/wire.ts";

type Backup = Pick<ModelSelection, "instanceId" | "model">;
type Checked = { ok: true; selection: ModelSelection } | { ok: false; error?: string };

export interface RecoveryBackupsDeps {
  engine: (instanceId: string) => ProviderInstance | null | undefined;
  store: Pick<Store, "bot" | "taskByThread">;
  configs: () => InstanceConfigMap;
  checkedSelection: (raw: unknown) => Checked;
  checkedSwitch: (current: BotRecord, raw: unknown) => Checked;
  switchNeedsAsk: (current: BotRecord, to: ModelSelection) => boolean;
  policyRefusal: (target: ProviderInstance) => string | undefined;
  givesWay: (own: ModelSelection, botModel: ModelSelection) => unknown;
  quotaSwitchEnabled: () => boolean;
}

/** One turn's attempt in the chain of backups a turn refused at its start goes through. */
export interface RecoveryScope {
  current: BotRecord;
  threadId: string;
  from: Pick<ProviderInstance, "instanceId" | "driverKind" | "adapter">;
  model: string;
  confined: boolean;
}

export function createRecoveryBackups(deps: RecoveryBackupsDeps) {
  function refusal(backup: Backup, on: RecoveryScope, attempts: readonly RecoveryAttempt[]): string | undefined {
    const checked = deps.checkedSelection(backup), target = checked.ok ? deps.engine(checked.selection.instanceId) : null;
    if (!checked.ok) return checked.error ?? "The backup AI is unavailable.";
    if (!target?.enabled || !refusalsAllow(attempts, target, deps.configs()[target.instanceId])) return "The backup AI is unavailable.";
    if (on.current.approvalGrant) return "Wait for the approval change to finish before switching models";
    if (deps.switchNeedsAsk(on.current, checked.selection)) return "Confirm switching this model with Ask permissions first (resetApprovalToAsk)";
    const policy = deps.policyRefusal(target);
    if (policy || deps.givesWay(checked.selection, deps.store.bot(on.current.id)?.modelSelection ?? on.current.modelSelection)) return policy ?? "The backup AI is unavailable.";
    if (on.confined && target.adapter.capabilities.guestTurns !== "confined") return "The backup cannot take this confined turn.";
    if (!deps.store.taskByThread(on.current.id, on.threadId)?.cwd) return "This older thread has no pinned working folder. Choose its backup manually.";
    return recoveryCapabilityError({ driverKind: on.from.driverKind, capabilities: on.from.adapter.capabilities },
      { driverKind: target.driverKind, capabilities: target.adapter.capabilities });
  }

  const here = (on: RecoveryScope): Backup => ({ instanceId: on.from.instanceId, model: on.model });

  return {
    /** The backups this attempt may weigh after it was refused: not gone to yet, enabled, and allowed by every refusal so far. */
    candidates<T extends Backup>(backups: readonly T[], on: RecoveryScope, attempts: readonly RecoveryAttempt[]): T[] {
      return untriedBackups(backups, here(on), attempts).filter((backup) => {
        const target = deps.engine(backup.instanceId);
        return Boolean(target?.enabled) && refusalsAllow(attempts, target!, deps.configs()[backup.instanceId]);
      });
    },
    /** The first of `candidates` the turn can switch to, or why the first one cannot. */
    pick<T extends Backup>(on: RecoveryScope, candidates: readonly T[], attempts: readonly RecoveryAttempt[]): { backup: T; selection: ModelSelection; target: ProviderInstance } | { refusal: string } {
      let first: string | undefined;
      for (const backup of candidates) {
        const why = refusal(backup, on, attempts), checked = why ? null : deps.checkedSwitch(on.current, backup);
        if (checked?.ok) return { backup, selection: checked.selection, target: deps.engine(checked.selection.instanceId)! };
        first ??= why ?? (checked && !checked.ok ? checked.error : undefined);
      }
      return { refusal: first ?? "The backup AI is unavailable." };
    },
    /** What `heldAtStart` weighs for this attempt: on a later one, only what the catch block could move the turn to. */
    hold(on: RecoveryScope | null, startup: readonly Backup[], tried?: readonly RecoveryAttempt[]): { recovering: boolean | ((scope: LimitScope) => boolean); counts: (backup: Backup) => boolean } {
      if (!tried || !on) return { recovering: startup.length > 0, counts: () => true };
      const self: RecoveryAttempt = { ...here(on), driverKind: on.from.driverKind };
      return {
        recovering: (scope) => !deps.quotaSwitchEnabled() && untriedBackups(startup, here(on), tried).some((backup) => !refusal(backup, on, [...tried, { ...self, why: scope }])),
        counts: (backup) => untriedBackups([backup], here(on), tried).length > 0 && !refusal(backup, on, tried),
      };
    },
  };
}

export type RecoveryBackups = ReturnType<typeof createRecoveryBackups>;
