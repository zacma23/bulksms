import React, { useState } from 'react';
import {
  LayoutDashboard,
  Send,
  Users,
  Megaphone,
  FileText,
  ShieldCheck,
  History,
  Menu,
  X,
  LogOut,
  Plus,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { usePortalData } from '../context/PortalDataContext';
import { ZacmaBrandMark } from './ZacmaBrandMark';
import type { PortalTab } from '../types/portal';

interface LayoutProps {
  activeTab: PortalTab;
  onSelectTab: (tab: PortalTab) => void;
  children: React.ReactNode;
}

interface NavItem {
  id: PortalTab;
  label: string;
  shortLabel: string;
  icon: React.ComponentType<{ className?: string }>;
  adminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', shortLabel: 'Home', icon: LayoutDashboard },
  { id: 'send', label: 'Send Bulk SMS', shortLabel: 'Send', icon: Send },
  { id: 'contacts', label: 'Contacts & Groups', shortLabel: 'Contacts', icon: Users },
  { id: 'campaigns', label: 'Campaigns', shortLabel: 'Campaigns', icon: Megaphone },
  { id: 'history', label: 'SMS History & Reports', shortLabel: 'History', icon: FileText },
  { id: 'staff', label: 'Staff & Roles', shortLabel: 'Staff', icon: ShieldCheck, adminOnly: true },
  { id: 'audit', label: 'Audit Log & Gateway', shortLabel: 'Audit', icon: History },
];

const TAB_TITLES: Record<PortalTab, string> = {
  dashboard: 'Admin Dashboard',
  send: 'Bulk SMS Composer',
  contacts: 'Contacts & Groups',
  campaigns: 'Campaign Management',
  history: 'SMS History & Reports',
  staff: 'Staff Accounts & Roles',
  audit: 'Audit Log & Gateway',
};

export function Layout({ activeTab, onSelectTab, children }: LayoutProps) {
  const { displayName, firebaseUser, role, signOut } = useAuth();
  const { activeDispatch, pauseActiveDispatch, resumeActiveDispatch, cancelActiveDispatch, clearActiveDispatch } =
    usePortalData();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const visibleNav = NAV_ITEMS.filter((item) => !item.adminOnly || role === 'admin');
  const bottomTabs: PortalTab[] = ['dashboard', 'send', 'contacts', 'campaigns'];

  const handleNavigate = (tab: PortalTab) => {
    onSelectTab(tab);
    setMobileMenuOpen(false);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col lg:flex-row">
      {/* Desktop Sidebar (256px) */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:fixed lg:inset-y-0 bg-slate-950 text-slate-100 border-r border-slate-800 z-30">
        <div className="h-16 px-5 flex items-center gap-3 border-b border-slate-800/80">
          <ZacmaBrandMark size={32} />
          <span className="font-display font-bold text-base tracking-tight text-white whitespace-nowrap">
            ZACMA SMS PORTAL
          </span>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto" aria-label="Primary Navigation">
          {visibleNav.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavigate(item.id)}
                className={`w-full min-h-[44px] flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  active
                    ? 'bg-blue-700 text-white'
                    : 'text-slate-300 hover:bg-slate-900 hover:text-white'
                }`}
              >
                <Icon className="w-[18px] h-[18px] shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800/80 space-y-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white truncate">{displayName}</p>
            <p className="text-xs text-slate-400 truncate">
              {firebaseUser?.email} · {role === 'admin' ? 'Administrator' : 'Staff'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void signOut()}
            className="w-full min-h-[42px] flex items-center justify-center gap-2 px-3 py-2 rounded-xl border border-slate-700 hover:border-red-500/60 hover:bg-red-950/40 text-slate-200 hover:text-red-200 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main Content Wrapper */}
      <div className="flex-1 flex flex-col lg:pl-64 min-w-0">
        {/* Compact Responsive Top Bar */}
        <header className="sticky top-0 z-20 h-14 lg:h-16 bg-white/95 backdrop-blur-md border-b border-slate-200 px-4 lg:px-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="lg:hidden">
              <ZacmaBrandMark size={28} />
            </div>
            <div className="min-w-0">
              <h1 className="font-display text-base lg:text-lg font-bold text-slate-900 truncate">
                {TAB_TITLES[activeTab]}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {activeTab !== 'send' && (
              <button
                type="button"
                onClick={() => handleNavigate('send')}
                className="min-h-[40px] inline-flex items-center gap-1.5 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs sm:text-sm font-semibold px-3.5 sm:px-4 py-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <Plus className="w-4 h-4" />
                <span>New SMS</span>
              </button>
            )}
          </div>
        </header>

        {/* Live Campaign Progress Banner */}
        {activeDispatch && (
          <div className="bg-slate-900 text-white px-4 lg:px-8 py-3 border-b border-slate-800">
            <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="space-y-1 min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xs sm:text-sm font-semibold">
                  <span className="truncate">{activeDispatch.campaignName}</span>
                  <span className="text-slate-400">·</span>
                  <span className="font-mono tabular-nums text-blue-300">
                    {activeDispatch.processed}/{activeDispatch.total}
                  </span>
                  <span className="text-slate-400">·</span>
                  <span className="font-mono tabular-nums text-emerald-400">
                    {activeDispatch.sent} sent
                  </span>
                  {activeDispatch.failed > 0 && (
                    <>
                      <span className="text-slate-400">·</span>
                      <span className="font-mono tabular-nums text-red-400">
                        {activeDispatch.failed} failed
                      </span>
                    </>
                  )}
                </div>
                <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-200 ${
                      activeDispatch.cancelled
                        ? 'bg-red-500'
                        : activeDispatch.paused
                          ? 'bg-amber-400'
                          : 'bg-blue-500'
                    }`}
                    style={{
                      width: `${
                        activeDispatch.total > 0
                          ? Math.round((activeDispatch.processed / activeDispatch.total) * 100)
                          : 0
                      }%`,
                    }}
                  />
                </div>
                {activeDispatch.lastError && (
                  <p className="text-xs text-red-300 truncate">{activeDispatch.lastError}</p>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {activeDispatch.running ? (
                  <>
                    {activeDispatch.paused ? (
                      <button
                        type="button"
                        onClick={resumeActiveDispatch}
                        className="min-h-[36px] px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold cursor-pointer whitespace-nowrap"
                      >
                        Resume
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={pauseActiveDispatch}
                        className="min-h-[36px] px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs font-semibold cursor-pointer whitespace-nowrap"
                      >
                        Pause
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={cancelActiveDispatch}
                      className="min-h-[36px] px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-xs font-semibold cursor-pointer whitespace-nowrap"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={clearActiveDispatch}
                    className="min-h-[36px] px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs font-semibold cursor-pointer whitespace-nowrap"
                  >
                    Dismiss
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Main Viewport */}
        <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 lg:py-7 pb-24 lg:pb-10">
          {children}
        </main>
      </div>

      {/* Mobile Fixed Bottom Thumb-Zone Navigation (5 destinations) */}
      <nav
        className="lg:hidden fixed bottom-0 left-0 right-0 z-30 bg-white/95 backdrop-blur-md border-t border-slate-200 pb-safe"
        aria-label="Mobile Navigation"
      >
        <div className="grid grid-cols-5 h-16">
          {bottomTabs.map((tabId) => {
            const item = NAV_ITEMS.find((n) => n.id === tabId)!;
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={tabId}
                type="button"
                onClick={() => handleNavigate(tabId)}
                className={`flex flex-col items-center justify-center gap-1 min-h-[44px] cursor-pointer transition-colors ${
                  active ? 'text-blue-700' : 'text-slate-500 hover:text-slate-900'
                }`}
              >
                <Icon className="w-5 h-5" />
                <span className="text-[11px] font-semibold leading-none">{item.shortLabel}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            className={`flex flex-col items-center justify-center gap-1 min-h-[44px] cursor-pointer transition-colors ${
              ['history', 'staff', 'audit'].includes(activeTab)
                ? 'text-blue-700'
                : 'text-slate-500 hover:text-slate-900'
            }`}
          >
            <Menu className="w-5 h-5" />
            <span className="text-[11px] font-semibold leading-none">More</span>
          </button>
        </div>
      </nav>

      {/* Mobile Slide-Up Action Sheet for Secondary Navigation & Sign Out */}
      {mobileMenuOpen && (
        <div
          className="lg:hidden fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-sm flex items-end"
          onClick={() => setMobileMenuOpen(false)}
        >
          <div
            className="w-full bg-white rounded-t-3xl p-5 pb-8 space-y-4 border-t border-slate-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-10 h-1.5 bg-slate-300 rounded-full mx-auto" />
            <div className="flex items-center justify-between">
              <div>
                <p className="font-display font-bold text-slate-900">{displayName}</p>
                <p className="text-xs text-slate-500">
                  {firebaseUser?.email} · {role === 'admin' ? 'Administrator' : 'Staff'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 cursor-pointer"
                aria-label="Close menu"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-1">
              {visibleNav
                .filter((n) => !bottomTabs.includes(n.id))
                .map((item) => {
                  const Icon = item.icon;
                  const active = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleNavigate(item.id)}
                      className={`w-full min-h-[48px] flex items-center gap-3 px-4 rounded-xl text-sm font-semibold transition-colors cursor-pointer ${
                        active
                          ? 'bg-blue-50 text-blue-700'
                          : 'text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      <Icon className="w-5 h-5" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
            </div>

            <div className="pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => void signOut()}
                className="w-full min-h-[48px] flex items-center justify-center gap-2 rounded-xl bg-red-50 hover:bg-red-100 text-red-700 text-sm font-semibold cursor-pointer"
              >
                <LogOut className="w-4 h-4" />
                Sign Out
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
