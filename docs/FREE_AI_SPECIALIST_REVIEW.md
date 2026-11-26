# Free AI specialist reviewers

## What this adds
A manually triggered, four-pass review lane for Ayyar Smart Trader pull requests:
- Data quality reviewer
- Quant/backtesting reviewer
- Risk/security reviewer
- Independent Qwen cross-check

The first three passes use Groq's free-tier `openai/gpt-oss-120b`; the cross-check uses `qwen/qwen3.8-27b`. Models and quotas can change. The workflow does not fall back to paid models, does not deploy, and cannot enable live trading.

## One-time account setup (owner action required)
1. Create/sign in to a GroqCloud account and confirm the current free-plan limits in the Groq console.
2. Create an API key. Never paste it into chat, source code, a commit, or a log.
3. In GitHub, open **Settings → Secrets and variables → Actions → New repository secret**.
4. Name it exactly `GROQ_API_KEY` and paste the key as its value.

This repository integration deliberately does not create provider accounts or API keys on the user's behalf. The GitHub connector available to this task cannot write repository Actions secrets.

## Run a review
1. Open **Actions → Ayyar Free AI Specialist Review → Run workflow**.
2. Enter the pull request number.
3. Download the `ayyar-ai-review-pr-<number>` artifact when complete.

The workflow fetches text-only PR patches through GitHub's read API, excludes common secret/config/binary paths, redacts common credential patterns, and sends only the patch to Groq. Do not include real account credentials, customer data, or private trading account details in code diffs. Groq says inference inputs/outputs are not retained by default, with limited reliability/abuse-monitoring exceptions; review its current data controls and terms before enabling.

## Safety and limits
- Manual trigger only; no background or per-commit calls.
- No paid provider fallback or billing configuration.
- Uses the provider's free-tier quotas; rate limits may change.
- AI output is advisory and can be wrong. It never merges PRs or modifies code.
- CI, human review, and deterministic tests remain mandatory.
- Live execution remains disabled; all trading validation remains paper-only.
- Keep the API key only in GitHub Actions secrets and rotate/revoke it if exposed.

## Provider references
- Groq rate limits: https://console.groq.com/docs/rate-limits
- Groq data controls: https://console.groq.com/docs/your-data
