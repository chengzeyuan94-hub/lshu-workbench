import { NavLink, Outlet } from 'react-router-dom';
import type { ReactNode } from 'react';
import { IconHome, IconTodo, IconChart, IconScan, IconSettings, IconHotspot, IconBrain } from './icons';
import AvatarMascot from './AvatarMascot';
import { Wallet } from 'pixelarticons/react';

const navItems = [
  { to: '/', label: '今日', code: 'H-01', icon: <IconHome /> },
  { to: '/todos', label: '待办', code: 'T-02', icon: <IconTodo /> },
  { to: '/finance', label: '财务分析', code: 'F-08', icon: <Wallet width={24} height={24} /> },
  { to: '/performance', label: '内容表现', code: 'C-03', icon: <IconChart /> },
  { to: '/hotspots', label: '热点雷达', code: 'R-04', icon: <IconHotspot /> },
  { to: '/knowledge', label: '知识大脑', code: 'K-05', icon: <IconBrain /> },
  { to: '/scan', label: '扫描报告', code: 'S-06', icon: <IconScan /> },
  { to: '/settings', label: '设置', code: 'S-07', icon: <IconSettings /> },
];

interface NavItemProps {
  to: string;
  label: string;
  code: string;
  icon: ReactNode;
}

function NavItem({ to, label, code, icon }: NavItemProps) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) => `nav-item${isActive ? ' nav-item--active' : ''}`}
    >
      <span aria-hidden="true">{icon}</span>
      <span>{label}</span>
      <span className="nav-item-code">{code}</span>
    </NavLink>
  );
}

export default function AppShell() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-logo">
            <AvatarMascot />
          </div>
          <div>
            <div className="sidebar-title">L叔的工作台</div>
            <div className="sidebar-sub">LOCAL COMMAND</div>
          </div>
        </div>
        <nav className="sidebar-nav" aria-label="主导航">
          {navItems.map((it) => (
            <NavItem key={it.to} {...it} />
          ))}
        </nav>
        <div className="sidebar-foot" aria-live="polite">
          <div className="sidebar-foot-badge">SYSTEM OK</div>
          <div className="sidebar-foot-text">本地运行 · 数据仅存本机</div>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
