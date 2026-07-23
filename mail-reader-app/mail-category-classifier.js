(function (root, factory) {
  const classifier = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = classifier;
    return;
  }
  root.MailCategoryClassifier = classifier;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const categoryStyles = Object.freeze({
    BT1: {
      code: "BT1",
      label: "初次询盘",
      color: "#e9a92f",
      description: "首次询价、报价请求、产品规格及交期咨询"
    },
    BT2: {
      code: "BT2",
      label: "追单邮件",
      color: "#35b980",
      description: "跟进报价、订单、交期、发货或回复进展"
    },
    BT3: {
      code: "BT3",
      label: "样品申请",
      color: "#4c9de7",
      description: "样品、寄样、试用、打样及评估申请"
    },
    BT4: {
      code: "BT4",
      label: "投诉反馈",
      color: "#ee745d",
      description: "质量异常、故障、损坏、错漏发及投诉反馈"
    },
    BT5: {
      code: "BT5",
      label: "合作咨询",
      color: "#8c6ce4",
      description: "代理、经销、渠道、供应商及项目合作咨询"
    },
    BT6: {
      code: "BT6",
      label: "售后凭证",
      color: "#2fa99f",
      description: "维修收据、服务确认、工作授权、发票及付款凭证"
    },
    transaction: {
      label: "交易通知",
      color: "#4c8ed9",
      description: "普通订单确认、付款、发货、物流及到货通知"
    },
    notification: {
      label: "系统通知",
      color: "#768791",
      description: "账户、安全、验证、账单及平台状态通知"
    },
    marketing: {
      label: "营销推广",
      color: "#d36f9d",
      description: "促销、招聘、活动、课程及订阅推广"
    },
    other: {
      label: "其他邮件",
      color: "#9aa3a8",
      description: "未达到业务类型或辅助分类明确判定条件的邮件"
    }
  });

  const categoryRules = Object.freeze([
    {
      id: "BT4",
      priority: 900,
      subject: [
        /投诉|抱怨|质量问题|质量异常|品质异常|故障|损坏|缺陷|不能使用|无法使用|漏发|错发|少发/i,
        /complaint|quality issue|defect|broken|not working|damaged|missing item|wrong item/i,
        /error with .*purchase/i
      ],
      body: [
        /客户投诉|投诉反馈|质量问题|质量异常|品质异常|设备故障|产品故障|损坏|缺陷|不能使用|无法使用|漏发|错发|少发/i,
        /complaint|quality issue|defect|broken|not working|damaged|missing item|wrong item/i
      ],
      attachments: [/投诉|质量问题|异常报告|complaint|defect|rma/i]
    },
    {
      id: "BT3",
      priority: 850,
      subject: [
        /样品|寄样|试样|打样|样板/i,
        /sample|trial|evaluation/i
      ],
      body: [
        /样品申请|申请.*样品|寄样|试样|打样/i,
        /sample request|request.*sample|trial|evaluation/i
      ],
      attachments: [/样品|sample|trial/i]
    },
    {
      id: "BT2",
      priority: 800,
      subject: [
        /追单|催单|催促|跟进|跟单|进展询问|再次确认|再次跟进/i,
        /follow.?up|checking in|reminder regarding|any update/i
      ],
      body: [
        /请问.{0,16}(进展|状态|交期)|烦请.{0,16}(跟进|回复|确认)|何时.{0,10}(发货|交付)|预计.{0,10}(发货|交付|到货)|尚未收到|仍未收到/i,
        /follow.?up|checking in|any update|please update|when (?:will|can).*(?:ship|deliver)|still waiting/i
      ],
      attachments: [/追单|跟进|进展|follow.?up|status/i]
    },
    {
      id: "BT5",
      priority: 750,
      subject: [
        /合作|代理|经销|分销|供应商|战略伙伴|渠道|商务洽谈|项目合作/i,
        /cooperation|partnership|distributor|reseller|sales agent|vendor onboarding|channel partner/i
      ],
      body: [
        /希望.{0,16}合作|寻求.{0,16}合作|成为.{0,12}(代理|经销商|供应商)|代理商|经销商|渠道合作|供应商准入/i,
        /interested in.*(?:cooperation|partnership)|become.*(?:distributor|reseller|agent|vendor)|channel partner/i
      ],
      attachments: [/合作方案|代理协议|供应商资料|partnership|distributor|vendor/i]
    },
    {
      id: "BT1",
      priority: 700,
      subject: [
        /询价|询盘|报价|价格咨询|产品咨询|采购需求|物料需求/i,
        /inquiry|enquiry|quote|quotation|\brfq\b|request for quotation|price inquiry/i
      ],
      body: [
        /请.{0,20}(报价|提供价格)|烦请.{0,20}(报价|提供价格)|询问.{0,12}(价格|交期|规格)|了解.{0,12}(价格|参数|规格|交期)/i,
        /request.*(?:quote|pricing)|could you.*(?:quote|price)|please.*(?:quote|price)|price inquiry/i,
        /\bexw\b|\bfob\b|\bcif\b|\bddp\b/i
      ],
      attachments: [/询价|报价|询盘|quote|quotation|\brfq\b/i]
    },
    {
      id: "BT6",
      priority: 650,
      subject: [
        /售后凭证|维修收据|服务确认|工作授权|维修发票|付款凭证|支付凭证|收据|发票/i,
        /service receipt|repair receipt|service confirmation|work authorization|payment receipt|invoice|receipt/i
      ],
      body: [
        /售后凭证|维修收据|维修配件|维修费|维修编号|维修 id|服务确认|工作授权|付款方式|支付金额|发票/i,
        /service receipt|repair receipt|repair item|repair fee|service confirmation|work authorization|payment method|amount paid|invoice/i
      ],
      attachments: [/维修|售后|收据|发票|service|repair|receipt|invoice/i]
    },
    {
      id: "transaction",
      priority: 500,
      subject: [
        /订单|采购单|采购订单|已收到.*订单|付款成功|支付成功|扣款成功/i,
        /\bpo\b|purchase order|order confirmation|order received|payment received|purchase/i,
        /发货|已发出|物流|快递|运单|到货|签收/i,
        /shipment|shipping|tracking|delivery/i
      ],
      body: [
        /订单号|订单状态|采购订单|下单|已付款|付款成功|支付成功/i,
        /purchase order|\bpo[\s:#-]|order number|payment received/i,
        /发货|已发出|物流|快递|运单|到货|签收/i,
        /shipment|shipping|tracking|delivery/i
      ],
      attachments: [/订单|采购|order|purchase|\bpo\b/i]
    },
    {
      id: "marketing",
      priority: 450,
      subject: [
        /促销|优惠|折扣|特价|低至|限时|狂欢|推广|广告|活动|大赛|招聘|岗位|职位|实习|投递|邀约|报名/i,
        /正式上线|正式发布|新品发布|内测/i,
        /\bsale\b|special offer|discount|promotion|newsletter|campaign/i
      ],
      sender: [
        /newsletter|growth-mail|quickjobs|campus@|mailf\.wisdomore/i,
        /marketing|promotion/i,
        /noreply@m\.xiaomi\.com|noreply@unccelearn\.org/i
      ],
      body: [
        /促销|优惠|折扣|特价|低至|限时|推广|广告|活动|大赛|招聘|职位|报名/i,
        /\bsale\b|special offer|discount|promotion|newsletter|campaign/i
      ]
    },
    {
      id: "notification",
      priority: 400,
      subject: [
        /通知|通知信|提醒|验证|驗證|认证|認證|登录|登入|安全|账户|帳戶|账号|帳號|密钥|密鑰|存储|儲存|已删除|已刪除|到期|下线|下線|计费|計費|账单|賬單|帳單|调整说明|調整說明/i,
        /sign.?in|security|account|storage|verification|billing/i
      ],
      sender: [
        /notificationmail|accountprotection|no-reply@onedrive/i,
        /support@sc\.mail\.deepseek|noreply@steampowered\.com/i
      ],
      body: [
        /登录|登入|安全|账户|帳戶|账号|帳號|验证|驗證|认证|認證|密钥|密鑰|存储|儲存|到期|下线|下線|计费|計費|账单|賬單|帳單/i,
        /sign.?in|security|account|storage|verification|billing/i
      ]
    }
  ]);

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function countPatternHits(value, patterns = []) {
    return patterns.reduce((count, pattern) => count + (pattern.test(value) ? 1 : 0), 0);
  }

  function getMailParts(mail) {
    return {
      subject: normalizeText(mail?.subject),
      sender: normalizeText(mail?.sender),
      body: normalizeText(Array.isArray(mail?.body) ? mail.body.join(" ") : mail?.body),
      attachments: normalizeText(
        (mail?.attachments || [])
          .map((attachment) => attachment?.name)
          .filter((name) => name && name !== "无附件")
          .join(" ")
      )
    };
  }

  function scoreRule(parts, rule) {
    const subjectHits = countPatternHits(parts.subject, rule.subject);
    const senderHits = countPatternHits(parts.sender, rule.sender);
    const bodyHits = Math.min(3, countPatternHits(parts.body, rule.body));
    const attachmentHits = countPatternHits(parts.attachments, rule.attachments);
    return {
      score: subjectHits * 8 + senderHits * 4 + bodyHits * 4 + attachmentHits * 5,
      evidence: { subjectHits, senderHits, bodyHits, attachmentHits }
    };
  }

  function classifyMail(mail) {
    const parts = getMailParts(mail);
    const matches = categoryRules
      .map((rule) => ({ id: rule.id, priority: rule.priority, ...scoreRule(parts, rule) }))
      .filter((match) => match.score > 0)
      .sort((left, right) => right.score - left.score || right.priority - left.priority);
    const bestMatch = matches[0];
    const id = bestMatch?.id || "other";
    return {
      id,
      label: categoryStyles[id].label,
      score: bestMatch?.score || 0,
      evidence: bestMatch?.evidence || {
        subjectHits: 0,
        senderHits: 0,
        bodyHits: 0,
        attachmentHits: 0
      }
    };
  }

  function categorizeMail(mail) {
    return classifyMail(mail).id;
  }

  return Object.freeze({
    categoryStyles,
    categoryRules,
    classifyMail,
    categorizeMail
  });
});
