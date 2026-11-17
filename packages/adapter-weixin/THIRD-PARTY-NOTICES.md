# Third-party notices

## @tencent-weixin/openclaw-weixin (vendored)

`vendor/openclaw-weixin/` is a vendored subset of `@tencent-weixin/openclaw-weixin` 2.4.10
([MIT license](vendor/openclaw-weixin/LICENSE)): the iLink HTTP transport (`api/`, `auth/`, `storage/`, `util/`), the CDN upload and
AES-128-ECB media layer (`cdn/`, `media/`) and the messaging layer (`messaging/`).
Three `openclaw/plugin-sdk` imports and one package-internal import are redirected to
`openclaw-shim.js`; `vendor/openclaw-weixin.manifest.json` records the file hashes.

The source of this vendoring is `dsh-plugin-weixin` (MIT, © panqing), which had already
done the redirection and recorded the manifest. Local patches preserve iLink package
metadata in the built adapter, check send response error codes, bound response
reads and CDN downloads/uploads (including a shared upload deadline and shutdown cancellation), and remove fallbacks to unscoped legacy credentials
and poll cursors.

Nothing else is vendored. No other runtime dependency is bundled with this package.
