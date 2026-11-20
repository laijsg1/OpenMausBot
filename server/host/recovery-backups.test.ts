import { describe, expect, it } from "vitest";
import { createRecoveryBackups } from "./recovery-backups.ts";

const engine = (instanceId: string, driverKind: string, extra: Record<string, unknown> = {}) =>
  ({ instanceId, driverKind, enabled: true, adapter: { capabilities: {} }, ...extra }) as never;
const ENGINES: Record<string, unknown> = {
  opencode: engine("opencode", "opencode"),
  claude: engine("claude", "claudeAgent"),
  claudeWork: engine("claudeWork", "claudeAgent"),
  codex: engine("codex", "codex"),
  off: engine("off", "codex", { enabled: false }),
};
const on = (instanceId: string, model: string) => ({ instanceId, model });

function recovery(options: { needsAsk?: (to: { instanceId: string }) => boolean; quotaSwitch?: boolean } = {}) {
  return createRecoveryBackups({
    engine: (id) => ENGINES[id] as never,
    store: { bot: () => ({ modelSelection: on("opencode", "go") }), taskByThread: () => ({ cwd: "/work" }) } as never,
    configs: () => ({}),
    checkedSelection: (raw) => (raw as { model: string }).model === "retired" ? { ok: false, error: "model \"retired\" is not offered" } : { ok: true, selection: raw as never },
    checkedSwitch: (_current, raw) => ({ ok: true, selection: raw as never }),
    switchNeedsAsk: (_current, to) => options.needsAsk?.(to) ?? false,
    policyRefusal: () => undefined,
    givesWay: () => false,
    quotaSwitchEnabled: () => options.quotaSwitch ?? false,
  });
}
const scope = (instanceId: string, model: string) => ({
  current: { id: "kai", modelSelection: on(instanceId, model) } as never, threadId: "t", from: ENGINES[instanceId] as never, model, confined: false,
});
const tried = [{ ...on("opencode", "go"), driverKind: "opencode" }];

describe("recovery backups", () => {
  it("picks the first backup that can take the turn, and names the first one's reason when none can", () => {
    const backups = recovery();
    expect(backups.pick(scope("opencode", "go"), [on("claude", "retired"), on("off", "m"), on("codex", "gpt")], tried)).toMatchObject({ backup: on("codex", "gpt") });
    expect(backups.pick(scope("opencode", "go"), [on("claude", "retired"), on("off", "m")], tried)).toEqual({ refusal: "model \"retired\" is not offered" });
  });

  it("weighs nothing the turn already went to, nothing disabled, and nothing an earlier limit rules out", () => {
    const limited = [{ ...on("claude", "opus"), driverKind: "claudeAgent", why: "engine" as const }];
    expect(recovery().candidates([on("opencode", "go"), on("off", "m"), on("claudeWork", "opus"), on("codex", "gpt")], scope("claude", "sonnet"), [...tried, ...limited]))
      .toEqual([on("codex", "gpt")]);
  });

  it("lets a backup with a cached hold take the turn when the next one would need the person's approval first", () => {
    const weigh = recovery({ needsAsk: (to) => to.instanceId === "codex" }).hold(scope("claude", "sonnet"), [on("claude", "sonnet"), on("codex", "gpt")], tried);
    expect(typeof weigh.recovering === "function" && weigh.recovering("model"), "no startup backup can carry on").toBe(false);
    expect(weigh.counts(on("codex", "gpt"))).toBe(false);
    const open = recovery().hold(scope("claude", "sonnet"), [on("claude", "sonnet"), on("codex", "gpt")], tried);
    expect(typeof open.recovering === "function" && open.recovering("model")).toBe(true);
    expect(open.counts(on("codex", "gpt"))).toBe(true);
  });

  it("keeps the first attempt as it was, and leaves a limit to the takeover's own list while the quota switch is on", () => {
    expect(recovery().hold(scope("claude", "sonnet"), [on("claude", "sonnet")]).recovering).toBe(true);
    const weigh = recovery({ quotaSwitch: true }).hold(scope("claude", "sonnet"), [on("claude", "sonnet"), on("codex", "gpt")], tried);
    expect(typeof weigh.recovering === "function" && weigh.recovering("model")).toBe(false);
  });
});
