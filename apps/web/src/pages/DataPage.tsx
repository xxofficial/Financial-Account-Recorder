import { useNavigate } from 'react-router-dom';
import { ArchiveRestore, ChevronRight, FileText, Inbox, Mail, Database } from 'lucide-react';
import { AppTopActions } from '../app/AppShell';

const entries = [
  { title: '备份与迁移', desc: '导出 v5 备份，导入旧版或其他设备数据', icon: ArchiveRestore, path: '/data/backup' },
  { title: '行情缓存', desc: '导入、导出与补齐历史日 K 线缓存', icon: Database, path: '/data/cache' },
  { title: '邮件收件箱', desc: '查看邮件同步与待确认导入内容', icon: Mail, path: '/data/imports' },
  { title: '结单导入', desc: '导入长桥、汇丰、uSMART 与嘉信文本结单', icon: FileText, path: '/data/imports' },
];

export default function DataPage() {
  const navigate = useNavigate();
  return <div className="page">
    <div className="screen-header"><div style={{ flex: 1 }}><h1>数据</h1><div className="text-xs text-muted">本地备份、缓存与待导入数据</div></div><AppTopActions /></div>
    <div className="surface-list">
      {entries.map(({ title, desc, icon: Icon, path }) => <button key={title} className="list-row" onClick={() => navigate(path)}>
        <Icon size={21} /><span className="list-row-main"><span className="list-row-title">{title}</span><span className="list-row-desc">{desc}</span></span><ChevronRight size={19} className="text-muted" />
      </button>)}
    </div>
    <div className="surface-card text-sm text-muted"><Inbox size={18} style={{ verticalAlign: 'middle', marginRight: 8 }} />导入的数据均会先展示预览；重复和冲突不会被静默覆盖。</div>
  </div>;
}
