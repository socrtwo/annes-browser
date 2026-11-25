# Anne's Browser: AI Development Token and Cost Estimate

Prepared 2026-11-24. All prices are USD per million tokens (MTok), list API rates. Claude prices are from Anthropic's published rate card. Other vendors' prices come from third-party trackers dated Sept–Nov 2026 and are marked as such. **Check each vendor's official pricing page before committing money.**

## 1. What is being built (sizing basis)

| Component | Est. lines |
|---|---|
| Shell, command registry runtime, menu generator, palette, keybindings | 25,000 |
| Feature implementations (Phases 3–7, ~800 canonical commands collapsing to ~350 distinct handlers) | 65,000 |
| Android GeckoView shell (Phase 9) | 15,000 |
| Tests | 30,000 |
| Catalog data (YAML) and generated docs | 15,000 |
| **Total** | **~150,000** |

At about 11 tokens per line, the finished artifact is about **1.6M tokens**. Agentic development generates far more than it keeps: reasoning, rewrites, failed attempts, test fixes and refactors. Typical overhead is 3–5×, which gives about **6.5M output tokens** (mid estimate, consistent with the phase budgets in ROADMAP.md).

Input dominates by volume. Every agent turn re-sends the working context (files, tool results, history). A ratio of about 50 input tokens per output token is typical for coding agents, and with prompt caching about 94% of that input is served from cache.

| Scenario | Output (incl. thinking) | Uncached input / cache writes | Cached input reads |
|---|---|---|---|
| Low (tight scope, few reworks) | 3.5M | 10M | 170M |
| **Mid** | **6.5M** | **20M** | **325M** |
| High (scope creep, heavy rework) | 13M | 40M | 650M |

Assumptions: Claude cache writes are billed at 1.25× base input (5-minute TTL; the 1-hour TTL costs 2×). Other vendors' uncached input is billed at their base input rate.

## 2. Claude estimates

| Model | Rates (in / out / cache read) | Low | **Mid** | High |
|---|---|---|---|---|
| **Claude Opus 5.5, medium effort** | $4 / $20 / $0.20 | $154 | **$295** | $590 |
| **Claude Fable 5.2** (high effort) | $8 / $40 / $0.20 | $274 | **$525** | $1,050 |
| Claude Sonnet 5.5 (reference) | $2 / $10 / $0.10 | $77 | **$148** | $295 |

Mid-case breakdown for Opus 5.5: output 6.5M × $20 = $130, cache writes 20M × $5 = $100, cache reads 325M × $0.20 = $65.

Mid-case breakdown for Fable 5.2: output $260, cache writes $200, cache reads $65.

Notes:
- **Opus 5.5 at medium** is its default effort and is adequate for most of this project, which is wide (many commands) rather than deep. Fable 5.2 costs about 1.8× as much per token and earns that mainly on the hard parts: engine integration, the command-registry architecture, security review, and gnarly protocol and emulation code. It may finish those parts in fewer turns.
- **Flat-rate subscription:** if the work runs in Claude Code on a Claude subscription plan rather than API billing, the marginal cost is the plan fee, subject to its usage limits. At this volume, spread over months, a subscription is likely cheaper than API billing. Check your plan's current limits.
- **Batch API** (50% off) does not suit interactive agent work, but it does suit Phase 1 catalog extraction (bulk summarizing of manuals and menu dumps).

## 3. Alternatives: is there a cheaper way?

The same mid token profile (6.5M output / 20M uncached / 325M cached input) is applied to each vendor's rates.

"Est. completion multiplier" is a **judgment, not a measurement**. It is the extra turns and tokens a model is likely to need to reach the same working result on a large multi-file agentic codebase, relative to Opus 5.5. Benchmark it on a real Phase 2 task before trusting it.

| Vendor / model | Rates (in / out / cached) | Raw mid | Est. completion multiplier | **Effective mid** | Source quality |
|---|---|---|---|---|---|
| Anthropic Claude Fable 5.2 | $8 / $40 / $0.20 | $525 | 0.85 | **~$446** | Official |
| Anthropic Claude Opus 5.5 (medium) | $4 / $20 / $0.20 | $295 | 1.0 | **$295** | Official |
| Anthropic Claude Sonnet 5.5 | $2 / $10 / $0.10 | $148 | 1.15 | **~$170** | Official |
| OpenAI GPT-6.1 Sol | $2 / $10 / $0.10 | $138 | 1.2 | **~$165** | Third-party, Nov 2026 |
| OpenAI GPT-6 Astra | $10 / $50 / ~$1.00* | $850 | 0.9 | **~$765** | Third-party |
| xAI Grok 4.7 | $2 / $6 / $0.50 | $242 | 1.4 | **~$338** | Third-party; costly cache reads |
| xAI grok-build-0.1 | $1 / $2 / ~$0.25* | $114 | 1.8 | **~$205** | Third-party |
| DeepSeek V4 Pro (peak) | $1.32 / $3.96 / $0.044 | $66 | 1.5 | **~$100** (off-peak ~$50) | Third-party, Nov 2026 |
| DeepSeek V4.1 Flash (peak) | $0.30 / $1.20 / $0.006 | $16 | 3.0 | **~$47** | Third-party; figures conflict |
| Moonshot Kimi K3.1 Pro | $2 / $10 / $0.20 | $170 | 1.4 | **~$238** | Third-party; dates inconsistent |
| Zhipu GLM-5.2 | $1.40 / $4.40 / $0.26 | $141 | 1.5 | **~$212** (or GLM Coding Plan, ~$18/mo) | Third-party |
| Mistral Devstral Medium | $0.40 / $2.00 / ~$0.04* | $34 | 2.5 | **~$85** (no cache discount: ~$150 raw) | Third-party; API reportedly business-only since Aug 2026 |
| Google Gemini 3.8 Flash | $0.75 / $3.75 / ~$0.075* (intro, doubles 2027-01-01) | $64 | 2.0 | **~$128** (2027: ~$255) | Official Google page |
| Google Gemini 3.1 Pro Preview | $2 / $12 / ~$0.20* | $183 | 1.3 | **~$238** | Official Google page |
| Meta Llama 4 Maverick (hosted) | $0.19 / $0.65 / none | $70 | 4.0+ | **~$280, likely fails** | Third-party |

\* Cached-input rate not found; assumed ~10% of base input (25% for grok-build).

### Bottom line

1. **Yes, there are cheaper per-token options.** The cheapest credible ones for a project this size are **DeepSeek V4 Pro** (about $50–100 effective, less off-peak) and **GPT-6.1 Sol or Claude Sonnet 5.5** (about $165–170). DeepSeek Flash, Devstral and Llama are cheaper on paper, but they are likely to stall on a 150k-line, multi-process Electron/GeckoView codebase. That turns token savings into lost hours.
2. **The token bill is small next to your time.** Every scenario here costs well under the value of the supervision hours involved. The model that needs the fewest corrections is usually the cheapest overall.
3. **Cheapest sensible setup: route work by difficulty.**
   - Fable 5.2 or Opus 5.5 for Phase 2 architecture, security review and hard integrations (~25% of output).
   - Sonnet 5.5, GPT-6.1 Sol or DeepSeek V4 Pro for bulk command handlers, tests and catalog work (~75%).
   - Estimated blended mid cost: **~$140–190**, compared with ~$295 for all-Opus or ~$446 for all-Fable.
4. **The biggest saving is architectural, not vendor choice.** Driving menus, palette, shortcuts and docs from one `commands.yaml` collapses ~800 commands into ~350 handlers. That is already assumed above. Without it, expect 2–3× the tokens.
5. **Jurisdiction and data handling:** DeepSeek, Kimi, GLM and Qwen first-party APIs are operated from China. For an open-source project that is usually acceptable, but if any private material goes into prompts, use their open-weight models through a host in your own jurisdiction instead. Hosted prices for those differ.

## 4. Caveats

- Effort setting changes token use substantially. Opus 5.5 at `high` could use 1.3–1.6× the output tokens of `medium`.
- Long-context surcharges (OpenAI above 272K input, xAI above 200K) are not modeled; disciplined context management avoids most of them.
- Prices move monthly. Re-run this table at the start of each phase.

## Sources (non-Anthropic prices)

- OpenAI: [reflektlab.ai](https://reflektlab.ai/blog/openai-api-pricing/), [mem0.ai](https://mem0.ai/library/llms-and-models/openai-api-pricing), [nOps](https://www.nops.io/blog/openai-api-pricing/)
- DeepSeek: [nxcode.io](https://www.nxcode.io/resources/news/deepseek-api-pricing-complete-guide-2026), [CloudZero](https://www.cloudzero.com/blog/deepseek-pricing/), [aipricing.guru](https://www.aipricing.guru/deepseek-pricing/)
- xAI: [usagebox](https://usagebox.com/articles/grok-api-pricing-2026), [promptsrush](https://promptsrush.com/blog/grok-pricing), [opslyft](https://www.opslyft.com/blog/ai-grok-api-pricing-2026)
- Mistral: [mistral.ai pricing](https://mistral.ai/pricing/api/), [agentdeals.dev](https://agentdeals.dev/mistral-api-pricing-2026)
- Kimi / GLM: [capitalandcompute.net](https://capitalandcompute.net/blog/china-ai-pricing/), [apidog](https://apidog.com/blog/chinese-llm-price-war-2026/), [jia.je coding plans](https://jia.je/kb/en/software/coding_plan.html)
- Google: [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing), [Vertex AI pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing)
- Meta Llama: [activepieces](https://www.activepieces.com/blog/meta-llama-api-pricing-cost-per-million-tokens-2026)
