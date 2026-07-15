import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, LockKeyhole, Save } from 'lucide-react';
import { db } from '../db/localDb';
import { BrokerPlatform, type PlatformType } from '../shared/models';
import { isAndroidNativeRuntime, nativeSecret, nativeSecretKeyForStatement } from '../platform/nativeRuntime';

type FeeOption = { id: string; label: string; description: string };

const feeOptions: Partial<Record<PlatformType, FeeOption[]>> = {
  EAST_MONEY: [{ id: 'east_money_standard', label: '标准公开价', description: '按东方财富国际当前公开费率估算。' }],
  LONGBRIDGE: [{ id: 'longbridge_public_promo', label: '固定公开费率（不含阶梯）', description: '按长桥官网固定公开示例估算港股、美股股票和美股期权。' }],
  HSBC: [
    { id: 'hsbc_standard', label: '标准公开价', description: '按汇丰标准公开佣金估算。' },
    { id: 'hsbc_trade25', label: 'Trade25', description: '按当月累计成交额判断免佣区间。' },
  ],
  USMART: [{ id: 'usmart_public_promo', label: '当前公开费率', description: '按 uSMART 当前公开活动价估算。' }],
  ZHUORUI: [
    { id: 'zhuorui_new_customer', label: '公开新客费率', description: '按卓锐官网公开港美股股票费率估算。' },
    { id: 'zhuorui_legacy_customer', label: '老客费率待核', description: '仅计入公开可确认项目，需人工复核。' },
  ],
  CHIEF: [{ id: 'chief_online_standard', label: '网上交易公开价', description: '按致富官网当前公开网上交易费率估算。' }],
  SCHWAB: [{ id: 'schwab_us_online', label: '美股线上交易', description: '按嘉信国际线上美股公开口径估算。' }],
};

const platforms = Object.values(BrokerPlatform).filter((platform) => platform.isConfigurable);
const statementPlatforms = platforms.filter((platform) => platform.supportsPdfImport);
const passwordKey = (platform: PlatformType) => `statement_pdf_password_${platform}`;

type Props = { activePlatform: PlatformType | null; enabledPlatforms: PlatformType[] };

export default function PlatformSettingsSection({ activePlatform, enabledPlatforms }: Props) {
  const [expanded, setExpanded] = useState<PlatformType | null>(activePlatform ?? enabledPlatforms[0] ?? null);
  const [feeSelections, setFeeSelections] = useState<Record<string, string>>({});
  const [promo, setPromo] = useState({ startDate: '', durationDays: 100 });
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [configuredPasswords, setConfiguredPasswords] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState('');

  const visiblePlatforms = useMemo(
    () => platforms.filter((platform) => enabledPlatforms.includes(platform.code)),
    [enabledPlatforms],
  );

  useEffect(() => {
    if (activePlatform && visiblePlatforms.some((platform) => platform.code === activePlatform)) setExpanded(activePlatform);
  }, [activePlatform, visiblePlatforms]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [selection, promoSetting] = await Promise.all([
        db.appSettings.get('platform_fee_plan_selections'),
        db.appSettings.get('zhuorui_promo_config'),
      ]);
      const nextPasswords: Record<string, string> = {};
      const nextConfigured: Record<string, boolean> = {};
      await Promise.all(statementPlatforms.map(async (platform) => {
        if (isAndroidNativeRuntime()) {
          const result = await nativeSecret.has({ key: nativeSecretKeyForStatement(platform.code) });
          nextConfigured[platform.code] = result.exists;
        } else {
          const saved = await db.appSettings.get(passwordKey(platform.code));
          nextPasswords[platform.code] = typeof saved?.value === 'string' ? saved.value : '';
          nextConfigured[platform.code] = Boolean(nextPasswords[platform.code]);
        }
      }));
      if (cancelled) return;
      setFeeSelections(selection?.value && typeof selection.value === 'object' ? selection.value as Record<string, string> : {});
      if (promoSetting?.value && typeof promoSetting.value === 'object') {
        const value = promoSetting.value as { startDate?: string; durationDays?: number };
        setPromo({ startDate: value.startDate ?? '', durationDays: Number(value.durationDays) || 100 });
      }
      setPasswords(nextPasswords);
      setConfiguredPasswords(nextConfigured);
    })();
    return () => { cancelled = true; };
  }, []);

  const saveFeePlan = async (platform: PlatformType, planId: string) => {
    const next = { ...feeSelections, [platform]: planId };
    setFeeSelections(next);
    await db.appSettings.put({ key: 'platform_fee_plan_selections', value: next, updatedAt: Date.now() });
    setMessage('费率方案已保存；交易表单会在支持的市场和品种上使用该方案估算。');
  };

  const savePromo = async () => {
    await db.appSettings.put({ key: 'zhuorui_promo_config', value: promo, updatedAt: Date.now() });
    setMessage('卓锐免佣设置已保存。');
  };

  const savePassword = async (platform: PlatformType) => {
    const value = passwords[platform] ?? '';
    if (isAndroidNativeRuntime()) {
      const key = nativeSecretKeyForStatement(platform);
      if (value.trim()) await nativeSecret.set({ key, value: value.trim() });
      else await nativeSecret.clear({ key });
    } else if (value.trim()) {
      await db.appSettings.put({ key: passwordKey(platform), value: value.trim(), updatedAt: Date.now() });
    } else {
      await db.appSettings.delete(passwordKey(platform));
    }
    setPasswords((current) => ({ ...current, [platform]: '' }));
    setConfiguredPasswords((current) => ({ ...current, [platform]: Boolean(value.trim()) }));
    setMessage(`${BrokerPlatform[platform].label}结单密码已更新。`);
  };

  return <section className="settings-platform-section">
    <div className="settings-section-heading"><div><h2>平台配置</h2><p>费率、免佣和结单密码按平台独立保存；当前平台会默认展开。</p></div></div>
    <div className="settings-platform-list">
      {visiblePlatforms.map((platform) => {
        const options = feeOptions[platform.code] ?? [];
        const isOpen = expanded === platform.code;
        return <article className={`settings-platform-card ${isOpen ? 'open' : ''}`} key={platform.code}>
          <button type="button" className="settings-platform-header" onClick={() => setExpanded(isOpen ? null : platform.code)}>
            <span><strong>{platform.label}</strong><small>{activePlatform === platform.code ? '当前平台' : '已启用平台'}</small></span>
            {isOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          </button>
          {isOpen && <div className="settings-platform-body">
            {options.length > 0 && <div className="settings-platform-subsection"><h3>费率方案</h3><p>只影响后续自动估算，不会改动已保存记录。</p><div className="settings-chip-wrap">{options.map((option) => <button type="button" key={option.id} className={feeSelections[platform.code] === option.id || (!feeSelections[platform.code] && option === options[0]) ? 'selected' : ''} onClick={() => void saveFeePlan(platform.code, option.id)}>{option.label}</button>)}</div><small>{options.find((option) => option.id === (feeSelections[platform.code] ?? options[0].id))?.description}</small><span className="settings-todo">仅在规则可核验的市场和品种上估算；结果须由用户确认后回填。</span></div>}
            {platform.code === 'ZHUORUI' && <div className="settings-platform-subsection"><h3>卓锐新客免佣</h3><p>免佣设置只影响后续费用估算，平台费率照常保留。</p><div className="settings-inline-fields"><label>免佣开始日期<input type="date" value={promo.startDate} onChange={(event) => setPromo({ ...promo, startDate: event.target.value })} /></label><label>免佣天数<input type="number" min="1" max="9999" value={promo.durationDays} onChange={(event) => setPromo({ ...promo, durationDays: Number(event.target.value) || 100 })} /></label></div><button type="button" className="primary settings-save-button" onClick={() => void savePromo()}><Save size={15} />保存免佣设置</button></div>}
            {statementPlatforms.some((candidate) => candidate.code === platform.code) && <div className="settings-platform-subsection"><h3>电子结单密码</h3><p>密码按平台安全保存；导入加密结单时会自动使用，不再在导入页面临时输入。</p><label className="settings-secret-field"><span><LockKeyhole size={15} />{configuredPasswords[platform.code] ? '已保存（留空可清除）' : '尚未设置'}</span><input type="password" value={passwords[platform.code] ?? ''} onChange={(event) => setPasswords({ ...passwords, [platform.code]: event.target.value })} placeholder={configuredPasswords[platform.code] ? '输入新密码，或留空清除' : '请输入 PDF 密码'} /></label><button type="button" className="settings-save-button" onClick={() => void savePassword(platform.code)}><Save size={15} />保存结单密码</button></div>}
          </div>}
        </article>;
      })}
    </div>
    {message && <p className="settings-feedback">{message}</p>}
  </section>;
}
