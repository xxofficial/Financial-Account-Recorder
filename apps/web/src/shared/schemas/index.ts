import { z } from 'zod';

// 1. 交易单条数据校验 Schema
export const transactionFormSchema = z.object({
  ledgerId: z.number({
    required_error: '账本 ID 为必填项',
    invalid_type_error: '账本 ID 必须为数字',
  }).int().positive(),
  
  tradeType: z.enum([
    'BUY', 'SELL', 'DEPOSIT', 'WITHDRAW', 'TRANSFER_OUT', 'TRANSFER_IN',
    'INTEREST', 'SPLIT', 'EXPIRE', 'DIVIDEND', 'TAX', 'FX_CONVERSION', 'OTHER'
  ], {
    required_error: '交易类型为必填项',
  }),

  platform: z.string({
    required_error: '交易平台为必填项',
  }).min(1, '请选择有效的交易平台'),

  market: z.enum(['A_SHARE', 'HK', 'US', 'CASH'], {
    required_error: '市场为必填项',
  }),

  symbol: z.string({
    required_error: '标的代码为必填项',
  }).trim().min(1, '标的代码不能为空'),

  name: z.string({
    required_error: '标的名称为必填项',
  }).trim().min(1, '标的名称不能为空'),

  tradeDate: z.string({
    required_error: '交易日期为必填项',
  }).regex(/^\d{4}-\d{2}-\d{2}$/, '交易日期格式必须为 YYYY-MM-DD'),

  tradeTime: z.string({
    required_error: '交易时间为必填项',
  }).regex(/^\d{2}:\d{2}:\d{2}$/, '交易时间格式必须为 HH:mm:ss'),

  price: z.number({
    required_error: '成交价格为必填项',
    invalid_type_error: '成交价格必须为数值',
  }).nonnegative('成交价格不能为负数'),

  quantity: z.number({
    required_error: '成交数量为必填项',
    invalid_type_error: '成交数量必须为数值',
  }).nonnegative('成交数量不能为负数'),

  commission: z.number({
    invalid_type_error: '佣金必须为数值',
  }).nonnegative('佣金费用不能为负数').default(0),

  tax: z.number({
    invalid_type_error: '税费必须为数值',
  }).nonnegative('税费不能为负数').default(0),

  note: z.string().max(200, '交易备注字数不能超过200个字').default(''),
  investorName: z.string().nullable().optional(),

  // 期权专用扩展字段
  assetType: z.enum(['STOCK', 'OPTION']).default('STOCK'),
  underlyingSymbol: z.string().nullable().optional(),
  expiryDate: z.string().nullable().optional(),
  strikePrice: z.number().nullable().optional(),
  optionType: z.enum(['CALL', 'PUT']).nullable().optional(),
  contractKey: z.string().nullable().optional(),
  occSymbol: z.string().nullable().optional(),

  // 货币/汇率转换专用扩展字段
  fxFromCurrency: z.string().nullable().optional(),
  fxFromAmount: z.number().nullable().optional(),
  fxToCurrency: z.string().nullable().optional(),
  fxToAmount: z.number().nullable().optional(),
  fxRate: z.number().nullable().optional(),
});

// 使用 refine 针对资产类型和交易类型增加联动条件校验
export const transactionSchema = transactionFormSchema
  .refine((data) => {
    // 校验如果是期权，相关属性必填
    if (data.assetType === 'OPTION') {
      return (
        !!data.underlyingSymbol?.trim() &&
        !!data.expiryDate &&
        /^\d{4}-\d{2}-\d{2}$/.test(data.expiryDate) &&
        data.strikePrice !== null &&
        data.strikePrice !== undefined &&
        data.strikePrice > 0 &&
        (data.optionType === 'CALL' || data.optionType === 'PUT')
      );
    }
    return true;
  }, {
    message: '期权资产类型下，标的资产、到期日、行权价以及期权方向 (CALL/PUT) 为必填项',
    path: ['assetType']
  })
  .refine((data) => {
    // 校验如果是货币兑换，相关币种与转换金额必填
    if (data.tradeType === 'FX_CONVERSION') {
      return (
        !!data.fxFromCurrency?.trim() &&
        data.fxFromAmount !== null &&
        data.fxFromAmount !== undefined &&
        data.fxFromAmount > 0 &&
        !!data.fxToCurrency?.trim() &&
        data.fxToAmount !== null &&
        data.fxToAmount !== undefined &&
        data.fxToAmount > 0 &&
        data.fxRate !== null &&
        data.fxRate !== undefined &&
        data.fxRate > 0
      );
    }
    return true;
  }, {
    message: '货币兑换交易中，兑换前后币种、对应金额以及汇率必须大于零且为必填项',
    path: ['tradeType']
  });

// 2. 账本校验 Schema
export const ledgerSchema = z.object({
  name: z.string({
    required_error: '账本名称为必选',
  }).trim().min(1, '账本名称不能为空').max(30, '账本名称长度不能超过30个字'),
  
  type: z.enum(['PERSONAL', 'JOINT'], {
    required_error: '账本类型为必选',
  }),

  description: z.string().max(100, '账本描述长度不能超过100个字').default(''),
  partners: z.string().default(''), // 逗号分隔的共有人
});
