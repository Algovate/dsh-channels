# dsh-channels

Use a DeepSeek Harness agent through personal WeChat or Telegram. The DSH
bundle handles sessions, tool approvals and replies. Install the adapter for
the chat service you use.

```sh
dsh plugin --profile default add @derekluo/dsh-channels@0.1.0 @derekluo/dsh-channels-weixin@0.1.0
```

For Telegram, install `@derekluo/dsh-channels-telegram@0.1.0` alongside the core
instead. Add the adapter's package name to `adapters` in
`~/.dsh/channels/config.json`, then configure its credentials and add your
sender ID to `allowedSenders`. The plugin denies senders by default.

See the [setup guide](https://github.com/Algovate/dsh-channels/blob/main/docs/OPERATIONS.md)
for credentials, configuration examples and troubleshooting. The packages
were installation tested on DSH Desktop `0.2.2-rc.3`.
