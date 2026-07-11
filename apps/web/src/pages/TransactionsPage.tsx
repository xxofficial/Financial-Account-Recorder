import { useState, useMemo, useEffect, useCallback } from 'react';
import { 
  Search, Plus, Calendar, ArrowUpRight, ArrowDownLeft, 
  ChevronDown, ChevronRight, SlidersHorizontal, CheckSquare, Square, Trash2
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { TransactionRepository, AppSettingRepository } from '../db/repositories';
import { Transaction } from '../db/schema';
import { BrokerPlatform, TradeTypeLabels, TradeType, PlatformType } from '../shared/models';

const txnRepo = new TransactionRepository();
const settingRepo = new AppSettingRepository();

export default function TransactionsPage() {
  const navigate = useNavigate();

  // Settings & DB states
  const [, setActiveLedgerId] = useState<number>(1);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);

  // Filter states
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('ALL');
  const [marketFilter, setMarketFilter] = useState<string>('ALL');
  const [platformFilter, setPlatformFilter] = useState<string>('ALL');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Collapsed months tracker
  const [collapsedMonths, setCollapsedMonths] = useState<Record<string, boolean>>({});

  // Batch action states
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // Fetch active ledger & search transactions
  const loadTransactions = useCallback(async () => {
    try {
      const ledgerSetting = await settingRepo.get('default_ledger');
      const currentLedgerId = typeof ledgerSetting === 'number' ? ledgerSetting : 1;
      setActiveLedgerId(currentLedgerId);

      const data = await txnRepo.searchAndFilter({
        ledgerId: currentLedgerId,
        keyword: searchTerm.trim() || undefined,
        market: marketFilter !== 'ALL' ? marketFilter : undefined,
        platform: platformFilter !== 'ALL' ? platformFilter : undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      });

      // Secondary in-memory filter for tradeType
      let filtered = data;
      if (typeFilter !== 'ALL') {
        filtered = data.filter(t => t.tradeType === typeFilter);
      }

      setTransactions(filtered);
    } catch (err) {
      console.error('加载交易流水失败:', err);
    } finally {
      setLoading(false);
    }
  }, [endDate, marketFilter, platformFilter, searchTerm, startDate, typeFilter]);

  useEffect(() => {
    void loadTransactions();
  }, [loadTransactions]);

  // Group transactions by month
  const groupedTransactions = useMemo(() => {
    const groups: Record<string, {
      monthStr: string;
      txs: Transaction[];
      netCashFlow: number; // DEPOSIT - WITHDRAW + INTEREST + DIVIDEND
      buysCount: number;
      sellsCount: number;
    }> = {};

    transactions.forEach(tx => {
      // Group key is YYYY-MM
      const month = tx.tradeDate.substring(0, 7);
      if (!groups[month]) {
        groups[month] = {
          monthStr: month,
          txs: [],
          netCashFlow: 0,
          buysCount: 0,
          sellsCount: 0
        };
      }

      groups[month].txs.push(tx);

      // Summarize stats
      const amount = tx.price * tx.quantity;
      if (tx.tradeType === 'DEPOSIT') {
        groups[month].netCashFlow += amount;
      } else if (tx.tradeType === 'WITHDRAW') {
        groups[month].netCashFlow -= amount;
      } else if (tx.tradeType === 'DIVIDEND') {
        groups[month].netCashFlow += (amount - tx.tax);
      } else if (tx.tradeType === 'INTEREST') {
        groups[month].netCashFlow -= amount;
      }

      if (tx.tradeType === 'BUY') {
        groups[month].buysCount++;
      } else if (tx.tradeType === 'SELL') {
        groups[month].sellsCount++;
      }
    });

    return Object.values(groups).sort((a, b) => b.monthStr.localeCompare(a.monthStr));
  }, [transactions]);

  // Batch action handlers
  const handleToggleSelect = (id: number) => {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedIds(next);
  };

  const handleSelectAll = () => {
    if (selectedIds.size === transactions.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(transactions.map(t => t.id!).filter(Boolean)));
    }
  };

  const handleBatchDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (selectedIds.size === 0) return;
    const confirmDelete = window.confirm(`确认要批量删除已选择的 ${selectedIds.size} 笔交易记录吗？该操作不可撤销！`);
    if (confirmDelete) {
      try {
        setLoading(true);
        const idsArray = Array.from(selectedIds);
        console.log('Executing batch delete for transaction IDs:', idsArray);
        for (const id of idsArray) {
          await txnRepo.delete(id);
        }
        setSelectedIds(new Set());
        setIsBatchMode(false);
        await loadTransactions();
        alert('选中的交易记录已成功删除！');
      } catch (err) {
        console.error('批量删除失败:', err);
        alert('删除失败，请重试');
      } finally {
        setLoading(false);
      }
    }
  };

  const toggleMonth = (month: string) => {
    setCollapsedMonths(prev => ({
      ...prev,
      [month]: !prev[month]
    }));
  };

  // Helper to format currency symbol
  const getCurrencySymbol = (market: string) => {
    switch (market) {
      case 'US': return '$';
      case 'HK': return 'HK$';
      case 'A_SHARE': return '¥';
      default: return '¥';
    }
  };

  // Helper to resolve colors for trade types
  const getTradeTypeStyle = (type: string) => {
    switch (type) {
      case 'BUY':
      case 'DEPOSIT':
      case 'TRANSFER_IN':
        return { color: 'var(--color-success)', bg: 'var(--color-success-bg)' };
      case 'SELL':
      case 'WITHDRAW':
      case 'TRANSFER_OUT':
        return { color: 'var(--color-error)', bg: 'var(--color-error-bg)' };
      case 'DIVIDEND':
      case 'INTEREST':
        return { color: 'var(--color-warning)', bg: 'var(--color-warning-bg)' };
      default:
        return { color: 'var(--color-info)', bg: 'var(--color-info-bg)' };
    }
  };

  return (
    <div style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem', position: 'relative' }}>
      {/* Header */}
      <div className="flex-between">
        <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700 }}>交易历史</h1>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button 
            type="button"
            onClick={() => {
              setIsBatchMode(!isBatchMode);
              setSelectedIds(new Set());
            }}
            style={{ 
              padding: '0.5rem 0.85rem', 
              fontSize: '0.85rem',
              borderColor: isBatchMode ? 'var(--accent)' : 'var(--border-color)',
              backgroundColor: isBatchMode ? 'rgba(59, 130, 246, 0.12)' : 'var(--bg-input)'
            }}
          >
            {isBatchMode ? '取消选择' : '批量管理'}
          </button>
          <button type="button" className="primary" onClick={() => navigate('/transactions/new')} style={{ padding: '0.5rem 1rem' }}>
            <Plus size={16} />
            记一笔
          </button>
        </div>
      </div>

      {/* Search and Filters */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <input 
              type="text" 
              placeholder="搜索代码、名称或备注..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{ paddingLeft: '2.25rem' }}
            />
            <Search size={16} style={{ position: 'absolute', left: '0.85rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          </div>
          <button 
            onClick={() => setShowAdvanced(!showAdvanced)} 
            style={{ 
              padding: '0.65rem', 
              borderColor: showAdvanced ? 'var(--accent)' : 'var(--border-color)' 
            }}
          >
            <SlidersHorizontal size={18} />
          </button>
        </div>

        {/* Dynamic type horizontal filter pills */}
        <div style={{ overflowX: 'auto', display: 'flex', gap: '0.5rem', paddingBottom: '0.25rem' }}>
          {['ALL', 'BUY', 'SELL', 'DEPOSIT', 'WITHDRAW', 'DIVIDEND', 'SPLIT', 'EXPIRE', 'FX_CONVERSION'].map((type) => (
            <button 
              key={type} 
              onClick={() => setTypeFilter(type)}
              style={{ 
                padding: '0.4rem 0.8rem', 
                fontSize: '0.8rem', 
                borderRadius: '20px',
                flexShrink: 0,
                border: typeFilter === type ? '1px solid var(--accent)' : '1px solid var(--border-color)',
                backgroundColor: typeFilter === type ? 'rgba(59, 130, 246, 0.15)' : 'var(--bg-input)',
                color: typeFilter === type ? 'var(--accent)' : 'var(--text-primary)',
              }}
            >
              {type === 'ALL' ? '全部类型' : TradeTypeLabels[type as TradeType] || type}
            </button>
          ))}
        </div>

        {/* Advanced Filters Panel */}
        {showAdvanced && (
          <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '0.25rem' }}>
            <div className="grid-cols-2">
              <div>
                <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>交易市场</label>
                <select value={marketFilter} onChange={(e) => setMarketFilter(e.target.value)}>
                  <option value="ALL">全部市场</option>
                  <option value="US">美股 (US)</option>
                  <option value="HK">港股 (HK)</option>
                  <option value="A_SHARE">A股 (A_SHARE)</option>
                  <option value="CASH">现金 (CASH)</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>券商平台</label>
                <select value={platformFilter} onChange={(e) => setPlatformFilter(e.target.value)}>
                  <option value="ALL">全部平台</option>
                  {Object.values(BrokerPlatform).map(p => (
                    <option key={p.code} value={p.code}>{p.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid-cols-2">
              <div>
                <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>起始日期</label>
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>结束日期</label>
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button 
                onClick={() => {
                  setMarketFilter('ALL');
                  setPlatformFilter('ALL');
                  setStartDate('');
                  setEndDate('');
                }}
                style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}
              >
                重置筛选
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Batch Select Actions Panel */}
      {isBatchMode && transactions.length > 0 && (
        <div className="flex-between glass-card" style={{ padding: '0.75rem 1rem', borderColor: 'var(--accent)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem' }}>
            <button type="button" onClick={handleSelectAll} style={{ padding: '0.35rem', background: 'none', border: 'none' }}>
              {selectedIds.size === transactions.length ? (
                <CheckSquare size={18} style={{ color: 'var(--accent)' }} />
              ) : (
                <Square size={18} />
              )}
            </button>
            <span>已选 {selectedIds.size} / {transactions.length} 项</span>
          </div>
          <button 
            type="button"
            className="danger" 
            disabled={selectedIds.size === 0} 
            onClick={handleBatchDelete}
            style={{ padding: '0.4rem 0.85rem', fontSize: '0.85rem' }}
          >
            <Trash2 size={14} />
            删除选中
          </button>
        </div>
      )}

      {/* Grouped Collapsible List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', paddingBottom: '2rem' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '3rem 0', color: 'var(--text-muted)' }}>加载中...</div>
        ) : groupedTransactions.length === 0 ? (
          <div className="glass-card" style={{ textAlign: 'center', padding: '3rem 0', color: 'var(--text-muted)' }}>
            没有符合条件的交易历史
          </div>
        ) : (
          groupedTransactions.map((group) => {
            const isCollapsed = !!collapsedMonths[group.monthStr];
            return (
              <div key={group.monthStr} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                
                {/* Month Group Header */}
                <div 
                  className="glass-card flex-between" 
                  onClick={() => toggleMonth(group.monthStr)}
                  style={{ 
                    padding: '0.65rem 1rem', 
                    cursor: 'pointer', 
                    backgroundColor: 'rgba(31, 41, 55, 0.4)',
                    borderColor: 'rgba(255, 255, 255, 0.05)'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    {isCollapsed ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
                    <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>{group.monthStr}</span>
                    <span className="text-xs text-muted">({group.txs.length} 笔交易)</span>
                  </div>
                  
                  {/* Month summary info */}
                  <div style={{ display: 'flex', gap: '1rem', fontSize: '0.8rem' }}>
                    {(group.buysCount > 0 || group.sellsCount > 0) && (
                      <span className="text-muted">
                        买入/卖出: {group.buysCount}/{group.sellsCount}
                      </span>
                    )}
                    {group.netCashFlow !== 0 && (
                      <span>
                        净流: 
                        <span className="font-mono font-bold" style={{ marginLeft: '0.2rem', color: group.netCashFlow >= 0 ? 'var(--color-success)' : 'var(--color-error)' }}>
                          {group.netCashFlow >= 0 ? '+' : ''}
                          {group.netCashFlow.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Month Items (Collapsible) */}
                {!isCollapsed && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                    {group.txs.map((tx) => {
                      const isSelected = selectedIds.has(tx.id!);
                      const isBuy = tx.tradeType === 'BUY' || tx.tradeType === 'DEPOSIT' || tx.tradeType === 'TRANSFER_IN';
                      const isSell = tx.tradeType === 'SELL' || tx.tradeType === 'WITHDRAW' || tx.tradeType === 'TRANSFER_OUT';

                      
                      const style = getTradeTypeStyle(tx.tradeType);
                      
                      return (
                        <div 
                          key={tx.id} 
                          className="glass-card" 
                          style={{ 
                            padding: '0.75rem 1rem', 
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.75rem',
                            borderColor: isSelected ? 'var(--accent)' : 'var(--border-color)',
                            backgroundColor: isSelected ? 'rgba(59, 130, 246, 0.05)' : 'var(--bg-card)',
                            cursor: 'pointer'
                          }}
                          onClick={() => {
                            if (isBatchMode) {
                              handleToggleSelect(tx.id!);
                            } else {
                              navigate(`/transactions/${tx.id}`);
                            }
                          }}
                        >
                          {/* Checkbox in Batch Mode */}
                          {isBatchMode && (
                            <div style={{ marginRight: '0.25rem' }}>
                              {isSelected ? (
                                <CheckSquare size={18} style={{ color: 'var(--accent)' }} />
                              ) : (
                                <Square size={18} style={{ color: 'var(--text-muted)' }} />
                              )}
                            </div>
                          )}

                          {/* Arrow Icon */}
                          <div style={{ 
                            background: style.bg,
                            color: style.color,
                            padding: '0.4rem',
                            borderRadius: '50%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0
                          }}>
                            {isBuy ? (
                              <ArrowDownLeft size={16} />
                            ) : isSell ? (
                              <ArrowUpRight size={16} />
                            ) : (
                              <Calendar size={16} />
                            )}
                          </div>

                          {/* Description details */}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                              <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{tx.symbol}</span>
                              <span style={{ 
                                fontSize: '0.7rem', 
                                color: style.color, 
                                backgroundColor: style.bg, 
                                padding: '0.1rem 0.35rem', 
                                borderRadius: '4px',
                                fontWeight: 600
                              }}>
                                {TradeTypeLabels[tx.tradeType as TradeType] || tx.tradeType}
                              </span>
                              <span className="text-xs text-muted">({BrokerPlatform[tx.platform as PlatformType]?.label || tx.platform})</span>
                            </div>
                            <div className="text-xs text-muted" style={{ marginTop: '0.2rem', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                              {tx.name} {tx.note ? `• ${tx.note}` : ''}
                            </div>
                          </div>

                          {/* Price & quantities or cash amount */}
                          <div style={{ textAlign: 'right', flexShrink: 0 }}>
                            <div style={{ 
                              fontWeight: 700, 
                              fontSize: '0.95rem',
                              color: isBuy ? 'var(--color-success)' : isSell ? 'var(--color-error)' : 'var(--text-primary)' 
                            }}>
                              {isBuy ? '+' : isSell ? '-' : ''}
                              {getCurrencySymbol(tx.market)}
                              {(tx.price * tx.quantity).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </div>
                            <div className="text-xs text-muted" style={{ marginTop: '0.2rem' }}>
                              {tx.market === 'CASH' || tx.tradeType === 'DEPOSIT' || tx.tradeType === 'WITHDRAW' ? (
                                <span>{tx.tradeDate}</span>
                              ) : (
                                <span>
                                  {tx.quantity} 股 @ {getCurrencySymbol(tx.market)}{tx.price.toFixed(2)}
                                </span>
                              )}
                            </div>
                          </div>

                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
