# Opt-in, single-owner dot bridge (experimental)

This patch prepares the bridge side only. It does **not** prove that the existing dot accepts a bot-authored mention, recognizes it as the owner's request, or replies in the same Slack thread. Do not bypass dot's identity/authorization checks or impersonate the owner. If dot ignores the bridge bot or treats its text as third-party content, stop and use a supported integration route.

## Configuration

Leave `DOT_BRIDGE_ENABLED` absent or `false` to preserve the original bridge. For an explicitly authorized, self-hosted installation set these through the deployment's existing secret/config management, never in Git:

- `DOT_BRIDGE_ENABLED=true`
- `DOT_SLACK_USER_ID`: the verified Slack user ID of the existing dot bot (U… / W…). This is the mention target.
- `DOT_SLACK_BOT_ID`: the same dot's verified bot ID (B…). Both IDs must match replies.
- `DOT_WECHAT_OWNER_ID`: exact sender ID from authenticated Hub events, not display name.
- `DOT_INSTALLATION_ID`: exact installation that owns this WeChat connection.
- `SLACK_CHANNEL_ID`: an already-authorized dedicated channel containing only the intended participants and bots. No channel creation or permission changes are included.
- Existing `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `HUB_URL`, `BASE_URL`, `DB_PATH` still apply. Use a different bridge bot from dot. Startup calls `auth.test` with the existing bridge token and refuses a dot/self identity collision.

Missing settings fail startup. No new OAuth scopes, Hub behavior, credentials, or dot configuration are created or changed. Only the existing global/self-hosted Slack credential path supports this mode; this is not per-tenant hosted configuration.

## Routing and privacy boundaries

Only direct messages carrying the configured `from_id` / `fromId`, from the pinned installation, enter dot mode. Recognized group fields are blocked. Unsupported Hub sender schemas are rejected rather than guessed. Verify your actual authenticated event schema before deployment; do not widen it to match arbitrary fields.

Text posts contain a real `<@DOT_USER_ID>` in both top-level text and Block Kit text, visibly authored by the bridge bot. Owner-supplied angle brackets and ampersands are escaped to prevent extra Slack mentions. Replies require both dot IDs, the dedicated channel, a non-root thread reply, an existing message mapping, the configured installation and configured owner. Human messages, self/other bots, edits, deletes, broadcasts and unmapped threads do not return to WeChat. Only normal messages and `bot_message` are admitted for the pinned identity. Bots that omit either identity field are deliberately unsupported.

Image, voice, video and file messages remain source placeholders; no media download, upload, speech recognition, transcription or attachment delivery is added. They do not automatically mention dot. Slack replies with only files are not forwarded.

Bridge success logs omit bodies; bridge and Slack send failure logs redact raw exceptions, which can embed provider response/request bodies. This is not an audit of unrelated Hub tools or third-party SDK debug logging. Do not enable payload-level SDK logging in production.

## Delivery limits

An SQLite claim is made before either network send. SHA-256 event/message keys are retained for seven days, up to 10,000 live entries, across restarts. Concurrent processes sharing the same SQLite database compete atomically. Full capacity fails closed until entries expire, without evicting live claims. Hub event IDs must remain stable on retries. Slack keys use installation/channel/message timestamp, so event-envelope retries collapse to one message.

This suppresses duplicate **application-level send attempts**, not end-to-end exactly-once delivery. A very fast dot reply arriving before the Slack post response is saved as a mapping is discarded; this patch does not buffer unmatched replies. A crash, timeout, rejected remote send, or mapping write failure after a claim may lose a message; claims are intentionally not released because the remote send may already have succeeded. Slack SDK transport retries remain its existing behavior. Replaying IDs after seven days can produce a new delivery. Separate databases do not coordinate claims. Existing message-link retention is unchanged. Back up/persist SQLite on a local volume; do not delete dedup rows to blindly retry.

## Validation and deployment checklist

1. Review the patch against its recorded base commit; install locked dependencies (`npm ci`), then run `npm run build`, `npx tsc --noEmit`, and `npm test`. See the accompanying validation report for baseline test failures.
2. Back up the existing SQLite database. The schema change only adds `bridge_deliveries` and an index. Run one instance with its persisted database and explicit configuration. Do not deploy this experimental mode in a shared catch-all Slack channel.
3. With separate authorization for real messages, send one harmless text from the configured WeChat owner. Verify exactly one Slack post, its bridge-bot sender, actual dot mention, and mapping. Have dot reply in that exact thread and verify one WeChat response.
4. Test a different sender, other bot, human reply, wrong channel, unthreaded response, edit/delete and duplicate event. All must be blocked or deduplicated. Check that application logs contain no message body.
5. A Slack mention alone is not evidence that dot accepts bot requests. If no reply occurs, inspect identity/event-subscription compatibility; do not broaden allowlists, spoof users, grant scopes or change Hub as a workaround.
6. Roll back by stopping the updated process and restoring the previous release/config. Leaving the additive table in place is harmless. Setting mode to `false` re-enables the original general bridge behavior, including forwarding other WeChat senders and human Slack replies; do not use that as a privacy-preserving pause. Stop the service to pause all traffic.

No live credentials, account logins, real messages, deployment or remote push are part of this local patch's validation.
