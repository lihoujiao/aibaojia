# 原生AI智能报价（示例预览）

第六轮只补了发布和配置说明，业务代码没有改。确认原文在 [docs/需求记录.md](docs/需求记录.md)。本轮说明见 [docs/第六轮进度.md](docs/第六轮进度.md) 和 [docs/平台发布与配置说明.md](docs/平台发布与配置说明.md)。号码认证字段见 [SMS-CONFIG-CHECKLIST.md](SMS-CONFIG-CHECKLIST.md)，里面没有密钥。页面、商家和价格仍是示例，不是已上线产品。

顶部提示：**页面示意·商品与价格均为示例、非已上线产品**。

本仓库不连接、不修改「AA学堂」的代码、域名、Cloudflare 或部署。目标域名 **ai.fde100.com.cn** 仍只是待配置，没有绑定，也没有改 DNS。

## 现在能说和不能说的短信状态

| 事项 | 状态 |
| --- | --- |
| 用户口述相关云服务已开通 | 是口述，本项目没有独立核验账号、余额、签名或模板 |
| 号码认证 provider 代码 | 已按官方 `Dypnsapi` `2017-05-25` 的 `SendSmsVerifyCode` / `CheckSmsVerifyCode` 实现 |
| 签名、模板、模板参数、凭据 | 未核验，也没有安全注入。生产路径缺任何必填项都会拒绝，不会改用模拟短信 |
| 真实发送、送达、验证码登录联调 | 没做。不能说用户已经收到短信 |

历史记忆里的签名和数字模板、以及旧源码里的 `code` / `min` / `##code##` 默认，都不写入本项目配置。经典短信 `dysmsapi SendSms` 不是这套账号对应的产品，本仓库不使用它。

官方说明：

- 发送：[SendSmsVerifyCode](https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-sendsmsverifycode)
- 核验：[CheckSmsVerifyCode](https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-checksmsverifycode)
- 产品说明：[短信认证集成](https://help.aliyun.com/zh/pnvs/developer-reference/the-server-integration-1)
- 公网接入点在已列出的地域都是 `dypnsapi.aliyuncs.com`：[服务接入点](https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-endpoint)
- 官方 Node/TS SDK：`@alicloud/dypnsapi20170525`
- 最小 RAM 动作：`dypns:SendSmsVerifyCode`、`dypns:CheckSmsVerifyCode`。这两项的资源类型都是全部资源 `*`，官方接口不支持更细的资源级授权。可以用 RAM 用户的 AccessKey，或带 `ALIYUN_DYPNS_SECURITY_TOKEN` 的 STS。不要用主账号长期调用。
- 验证码由号码认证在 `TemplateParam` 含官方占位 `##code##` 时生成，并由 `CheckSmsVerifyCode` 核验。本服务不保存、不回显、不写日志。若模板参数里是调用方自己填的明文验证码，官方说明 `CheckSmsVerifyCode` 无法核验，因此本项目会直接拒绝这种配置，而不是改成本地比对。
- 参数名不预设。整段 `ALIYUN_DYPNS_TEMPLATE_PARAM` 由以后核验过的模板注入。
- 国家码不填时沿用接口默认 `86`。官方 SDK 说明目前只支持大陆号码。国际号码待确认。
- 发送按运营商回执计费，核验免费。单次金额待确认。本环境没有发送。

必填且当前都为空：`ALIYUN_DYPNS_ACCESS_KEY_ID`、`ALIYUN_DYPNS_ACCESS_KEY_SECRET`、`ALIYUN_DYPNS_SIGN_NAME`、`ALIYUN_DYPNS_TEMPLATE_CODE`、`ALIYUN_DYPNS_TEMPLATE_PARAM`。可选：`ALIYUN_DYPNS_SECURITY_TOKEN`、`ALIYUN_DYPNS_SCHEME_NAME`、`ALIYUN_DYPNS_COUNTRY_CODE`。见 `.env.example`。不要把密钥贴到聊天或仓库。

一次真实发送测试已经另行授权，但号码不在本仓库。凭据和模板未注入之前不会试发，失败也不会自动重发，也不会发给其他号码。

## 预览

本轮没有可从公网打开并核验的 https 预览。查过的正式途径只有：Cursor 把端口转到使用者自己的电脑或内部浏览器，以及由使用者自己发布的 Vercel 或 Cursor Apps。这台代理没有关联环境，也没有返回任何 https 应用地址。没有使用隧道，没有镜像到 GitHub，没有改 DNS，也没有做付费部署。虚拟机里的 `127.0.0.1` 不能当作外部预览。

```bash
npm install
npm run dev
```

需要本机 PostgreSQL。当前验证用的是 VM 上的 PostgreSQL 16，库角色 `quoteapp` 只接受本机连接。

## 测试

2026-11-16 在本环境对真实 PostgreSQL 执行，不使用 SQLite：

```bash
npm test
```

脚本是 `PG_ADMIN_URL=postgres://quoteapp@127.0.0.1:5432/postgres OTP_DELIVERY=test NODE_ENV=development tsx --test tests/*.test.ts`。`OTP_DELIVERY=test` 只在非生产的自动化测试里生效，生产模式会拒绝它。测试不调用阿里云，也不发短信。

2026-11-16 第三轮收口结果：`npm test` 退出码 0，`tests 28`、`pass 28`、`fail 0`，约 2.6 秒。覆盖此前仍有效的断言，以及平台佣金优先、显式 0 拒绝、部分出库与幂等、取消或超时事件立即释放、并发出库与取消、超时配置合法性、跨商家隔离、未配置时没有隐式默认时长。`npx eslint app components lib tests --max-warnings 0` 退出码 0。`npx next build` 退出码 0。

## 已实现

- PostgreSQL 上的商品、按商品保存的单位和比例、规格、现货、预占、可用库存。
- 下单预占。部分出库按实出数量各减一次现货和对应预占，未出部分继续预占。重复同一幂等键不双扣。累计出库不能超过订单。
- 取消，或收到已判定超时的事件时，立即释放尚未出库的预占。没有预填的超时时长。
- 商家显式保存分钟、小时或天后，新订单快照该时长。本进程定期扫描到期订单并释放剩余预占。未配置的订单不会被扫描判超时。修改配置不改写已有订单。谁可以配置、是否应该追溯，仍未确认。0、负数、缺单位、跨商家写入都会拒绝。平台、集团、客服代设返回未确认。
- 商家和平台各自保存佣金。双方都保存时平台优先。任一侧都没保存时，仍用此前已确认的 5%，不把这说成新的继承规则。显式 0 不保存。
- 换算按整数基准单位做四舍五入。1/3 这类会落到 0 的结果不入库，因为整数存储留不住小数。保留几位仍未指定。
- 历史入库和订单保存当时的比例、数量和价格。
- 手机号验证码登录。演示身份切换返回 410。
- 号码认证发送和核验的服务端适配。未配置时拒绝。

## 未实现或未联调

- 真实短信发送、运营商送达、用户收码后的登录。
- 谁可以改超时配置、新配置是否应该追溯已有订单。当前只快照新订单，不把这个实现说成已确认的追溯规则。
- 退货、盘点、调拨。
- 智能客服、比价、拍卖、四流合一等非本轮范围，导航里仍是灰色不可用。
- 用户可直接打开的外部预览地址。Cloud Agent 只会把监听端口转到 Cursor 的 Forwarded Ports / 内部浏览器；本轮没有使用 Vercel，也没有公网地址。`127.0.0.1:43123` 只在这台虚拟机里可访问。
