# 第七轮源码交接说明

这是给公开仓库交接用的源码包，不是 Git 历史，也不是已发布的应用。

- 源提交：`6b5143a81c1d13d3301fe2f0d1bb11172b2ee8cf`
- 来源是 Origin 上的私有工作副本，不是 `github.com/lihoujiao/aibaojia`。
- 目标仓库目前公开，根目录 README 只有标题 `aibaojia`。本包没有 `README.md`，第七轮说明在 `README.round7.md`，避免覆盖目标仓库已有 README。
- 未包含 `.git`、`.env`、`.env.example`、`data/`、`node_modules`、内部需求与进度文档、验收截图。
- 手机号只有示例号 `13800000001` 至 `13800000005`。没有真实用户号码、邮箱或经营数据。
- `tests/helpers.ts` 与 `tests/dypns.test.ts` 里的 `test-only-*`、`test-key-id`、`test-key-secret` 是测试桩字面量，不是运行环境密钥。
- 正式利息总额仍不可计算。批次本金分配、部分还本后续计息、月结锚点、不足月，以及按日/按批/按月的累计次序都没有补上。

应用读取这些环境变量名，值不在本包中：`DATABASE_URL`、`SESSION_SECRET`、`OTP_PEPPER`、`OTP_DELIVERY`、`ALIYUN_DYPNS_ACCESS_KEY_ID`、`ALIYUN_DYPNS_ACCESS_KEY_SECRET`、`ALIYUN_DYPNS_SECURITY_TOKEN`、`ALIYUN_DYPNS_SIGN_NAME`、`ALIYUN_DYPNS_TEMPLATE_CODE`、`ALIYUN_DYPNS_TEMPLATE_PARAM`、`ALIYUN_DYPNS_SCHEME_NAME`、`ALIYUN_DYPNS_COUNTRY_CODE`。

本阶段没有部署，没有公网应用地址，也没有把 `ai.fde100.com.cn` 绑到任何托管。Cursor Apps 文档要求由 Cloud Agent 准备好之后，在预览托盘里由用户自己选择地址并确认发布。文档没有写把已有自定义域名指到该应用的步骤。
