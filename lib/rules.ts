export const DISCLAIMER = "页面示意·商品与价格均为示例、非已上线产品";

export const TARGET_DOMAIN = "ai.fde100.com.cn";

export const TARGET_DOMAIN_NOTE =
  "ai.fde100.com.cn 记为待配置的目标域名。当前预览没有绑定该域名，没有改动现网 DNS、证书或生产配置，也不能把它写成已经上线。";

/** 第一轮临时规则，保留作历史。2026-11-16 21:43 起被已确认规则替代的部分见 docs/需求记录.md。 */
export const HISTORICAL_ROUND1 = {
  recordedAt: "2026-11-16 第一轮",
  commission:
    "建议/临时：平台价 = 底价 + 底价 × 佣金比例，佣金按分四舍五入。比例放在配置里，只为跑通流程，不是已定案的计收方式。",
  unit: "待确认：单位只作记录，例如斤、箱、件。本轮不设默认换算公式，也不把不同单位的数量加总。",
  deduction: "建议/临时：现货在出库确认时做原子扣减。库存不足就拒绝，扣完前不预占。正式的扣减或预占时点仍待确认。",
  stack: "建议/临时：单一 Next.js Web 应用 + Node 内置 SQLite（node:sqlite）。这不是已确认的最终技术栈。",
  auth: "演示身份点击进入，不使用密码。这不是生产认证。",
} as const;

export const COMMISSION_RULE =
  "已确认：平台价 = 商家底价 + 按底价计算的可配置比例佣金，默认 5%。商家和平台都保存了费率时，平台设置优先于商家设置。显式 0、平台未设置时是否沿用商家费率，本次没有细化。";

export const UNIT_RULE =
  "已确认：换算比例按商品保存，不能串用。换算采用四舍五入。保留几位和最小计量精度仍未指定；当前按基准单位整数存储，这是实现限制。历史单据仍快照当时比例和结果。";

export const DEDUCTION_RULE =
  "已确认：下单预占。部分出库按实际数量各减一次现货和对应预占，未出部分继续预占。取消或已被判定超时后立即释放剩余预占。超时时长可配置，未配置时不会自动超时，开发不设默认时长。已保存的时长会写进新订单快照，到期后自动判定并释放剩余预占。配置变更是否追溯旧订单仍待确认，当前不改写已有订单。";

export const OVERLAP_RULE =
  "建议/临时：同一时刻如果有多条未过期报价，采用创建时间最新的一条。已经过期的报价，即使创建更晚，也不能当作有效实时价。这一条没有在 2026-11-16 21:43 的确认里改写。";

export const UNIMPLEMENTED_FLOWS =
  "退货、盘点、调拨仍未实现。取消、已被判定超时后的立即释放，以及部分出库，已按确认口径实现。谁可以改超时配置、变更是否追溯已有订单，仍未指定。已保存的时长只作用于带快照的新订单。";

export const TIMEOUT_SCAN_NOTE =
  "服务大约每 15 秒查看一次哪些订单已经到达自己的截止时间。这 15 秒是识别延迟，不是订单超时时长，也不能在未配置时充当默认时长。";

export const DEFAULT_COMMISSION_BPS = 500;

export const ROUNDING_RULE =
  "已确认：单位换算采用四舍五入。具体保留几位、最小计量单位仍未指定。当前库存按基准单位的整数保存，这是实现限制，不是已确认的业务精度。";

export const STACK_NOTE =
  "已确认使用 TypeScript 和 PostgreSQL，登录方式为手机验证码。短信产品按官方号码认证 Dypnsapi 2017-05-25 实现。Next.js 仍是当前实现选择，不能把整个技术栈说成都已确认。";

export const SMS_NOTE =
  "号码认证发送与核验代码已按官方接口接好，但签名、模板参数和凭据都还没有核验注入。缺任何一项都会拒绝发送，不会改用模拟短信冒充成功。验证码不会出现在页面或日志里。";

export const OUT_OF_SCOPE = [
  "智能客服",
  "跨商家比价",
  "尾货 / 秒单拍卖",
  "订单四流合一",
  "预订单 / 需求市场",
  "易货",
  "沪滇帮扶与公益助老",
  "产业招商",
] as const;

export const VIRTUAL_PHONES = [
  { phone: "13800000001", title: "示例商家甲", roleLabel: "供货方" },
  { phone: "13800000002", title: "示例商家乙", roleLabel: "供货方" },
  { phone: "13800000003", title: "示例农业集团", roleLabel: "集团" },
  { phone: "13800000004", title: "平台管理", roleLabel: "平台" },
  { phone: "13800000005", title: "客服示例", roleLabel: "客服" },
] as const;

export const OTP_LIMITS = {
  codeDigits: 6,
  ttlMs: 5 * 60 * 1000,
  maxSendsPerPhone: 3,
  maxSendsPerIp: 10,
  windowMs: 10 * 60 * 1000,
  maxAttempts: 5,
  note: "建议：6 位、5 分钟过期、单号码 10 分钟最多 3 次、单 IP 10 分钟最多 10 次、单次挑战最多 5 次错误。这些数字不是业务方另行确认的阈值。",
} as const;
