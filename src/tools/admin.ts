import type { AppContext } from "../config.js";
import { isHistoryEnabled } from "../util/persistence.js";

/**
 * doctor — health and configuration self-check. Surfaces every thing an operator
 * needs to know in one call: API reachability, network mismatch, signer mode,
 * policy summary, persistence state.
 */
export async function doctor(ctx: AppContext) {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // 1. /health round-trip — also captures executor_id for the next check
  let healthExecutorId: number | string | undefined;
  try {
    const h = await ctx.sera.getHealth();
    healthExecutorId = h.executor_id;
    checks.push({
      name: "sera_health",
      ok: h.status === "healthy",
      detail: `status=${h.status}${h.executor_id !== undefined ? ` executor_id=${h.executor_id}` : ""}`,
    });
  } catch (e: any) {
    checks.push({ name: "sera_health", ok: false, detail: e?.message ?? String(e) });
  }

  // 1b. Executor ID surfaced as its own check — drift invalidates outstanding
  // signed uuid_int values, so operators want this loud. Mainnet default is 0.
  if (healthExecutorId !== undefined) {
    const expected = ctx.cfg.network === "mainnet" ? 0 : healthExecutorId;
    const ok = Number(healthExecutorId) === Number(expected);
    checks.push({
      name: "executor_id",
      ok,
      detail: ok
        ? `executor_id=${healthExecutorId} (matches expected for ${ctx.cfg.network})`
        : `executor_id=${healthExecutorId} differs from typical mainnet default (0). Any pre-generated uuid_int values that embedded a different executor_id will be rejected. Re-quote.`,
    });
  }

  // 2. /config + network sanity
  let liveCfg: Awaited<ReturnType<typeof ctx.sera.getConfig>> | undefined;
  try {
    liveCfg = await ctx.sera.getConfig();
    const expected = ctx.cfg.network === "mainnet" ? 1 : 11155111;
    const networkOk = liveCfg.chain_id === expected;
    checks.push({
      name: "network_sanity",
      ok: networkOk,
      detail: networkOk
        ? `chain_id=${liveCfg.chain_id} matches SERA_NETWORK=${ctx.cfg.network}`
        : `MISMATCH: SERA_NETWORK=${ctx.cfg.network} but /config returned chain_id=${liveCfg.chain_id}`,
    });
  } catch (e: any) {
    checks.push({ name: "network_sanity", ok: false, detail: e?.message ?? String(e) });
  }

  // 2b. Contract addresses surfaced from /config — operators want to see what
  // they'll actually be signing against. Use these (not hardcoded) for any
  // signed payload; addresses can drift between deployments.
  if (liveCfg) {
    checks.push({
      name: "contracts",
      ok: !!(liveCfg.sera_address && liveCfg.vault_address && liveCfg.sor_address),
      detail:
        `sera=${liveCfg.sera_address ?? "?"} vault=${liveCfg.vault_address ?? "?"} ` +
        `sor=${liveCfg.sor_address ?? "?"}`,
    });

    // 2c. VL batch limits from /config (read at startup; don't hardcode).
    const vl = liveCfg.limits?.vl_batch;
    if (vl) {
      checks.push({
        name: "vl_batch_limits",
        ok: true,
        detail: `min=${vl.min} max=${vl.max} (live cap from /config — use sera.place_vl_batch with ≤ max siblings)`,
      });
    }
  }

  // 3. /tokens loadable
  try {
    const t = await ctx.sera.getTokens();
    checks.push({ name: "tokens_registry", ok: t.tokens.length > 0, detail: `${t.tokens.length} tokens loaded` });
  } catch (e: any) {
    checks.push({ name: "tokens_registry", ok: false, detail: e?.message ?? String(e) });
  }

  // 4. Signer mode
  checks.push({
    name: "signer_mode",
    ok: true,
    detail:
      ctx.signer.mode === "external"
        ? "external (server holds no key — agents must sign EIP-712 separately)"
        : ctx.signer.mode === "local"
        ? "LOCAL (server signs and submits — make sure SIGNER_PRIVATE_KEY is funded and scoped)"
        : "readonly (execution disabled)",
  });

  // 5. Policy summary — surface every parsed value so operators can audit
  const p = ctx.policy.config;
  checks.push({
    name: "policy",
    ok: true,
    detail:
      `symbols=${p.allowedSymbols.length || "all"}, ` +
      `recipients=${p.allowedRecipients.length || "any"}, ` +
      `max_notional_usd=${p.maxNotionalUsd || "none"}, ` +
      `daily_volume_cap_usd=${p.dailyVolumeCapUsd || "none"}, ` +
      `default_expiration_s=${p.defaultExpirationSeconds}, ` +
      `max_expiration_s=${p.maxExpirationSeconds}, ` +
      `output_tolerance_bps=${p.outputToleranceBps}, ` +
      `dry_run=${p.dryRun}, ` +
      `volume_persistent=${p.persistentDailyVolume}`,
  });

  // 6. History persistence + privacy posture
  checks.push({
    name: "history_persistence",
    ok: true,
    detail: isHistoryEnabled()
      ? `enabled (SERA_HISTORY_DB set, owner_hash=${p.historyHashOwner})`
      : "disabled (set SERA_HISTORY_DB to enable)",
  });

  return {
    network_label: ctx.cfg.network,
    base_url: ctx.cfg.baseUrl,
    overall_ok: checks.every((c) => c.ok),
    checks,
  };
}
