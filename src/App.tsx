import { useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { PortalDataProvider } from './context/PortalDataContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Layout } from './components/Layout';
import { ZacmaBrandMark } from './components/ZacmaBrandMark';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { SendSmsPage } from './pages/SendSmsPage';
import { ContactsPage } from './pages/ContactsPage';
import { CampaignsPage } from './pages/CampaignsPage';
import { HistoryPage } from './pages/HistoryPage';
import { StaffPage } from './pages/StaffPage';
import { AuditGatewayPage } from './pages/AuditGatewayPage';
import { MobileBridgeRunnerPage } from './pages/MobileBridgeRunnerPage';
import type { PortalTab } from './types/portal';

function isPhoneBridgeRoute(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return params.has('pair') || params.get('mode') === 'phone-bridge';
}

function PortalShell() {
  const { loading, authorized } = useAuth();
  const [activeTab, setActiveTab] = useState<PortalTab>('dashboard');

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center gap-4 p-6">
        <ZacmaBrandMark size={44} />
        <div className="text-center space-y-1">
          <p className="font-display font-bold text-slate-900">ZACMA SMS PORTAL</p>
          <p className="text-xs text-slate-500">Verifying credentials and loading workspace...</p>
        </div>
      </div>
    );
  }

  if (!authorized) {
    return <LoginPage />;
  }

  return (
    <PortalDataProvider>
      <Layout activeTab={activeTab} onSelectTab={setActiveTab}>
        {activeTab === 'dashboard' && <DashboardPage onNavigate={setActiveTab} />}
        {activeTab === 'send' && <SendSmsPage onNavigate={setActiveTab} />}
        {activeTab === 'contacts' && <ContactsPage />}
        {activeTab === 'campaigns' && <CampaignsPage onNavigate={setActiveTab} />}
        {activeTab === 'history' && <HistoryPage />}
        {activeTab === 'staff' && <StaffPage />}
        {activeTab === 'audit' && <AuditGatewayPage />}
      </Layout>
    </PortalDataProvider>
  );
}

export default function App() {
  if (isPhoneBridgeRoute()) {
    return (
      <ErrorBoundary>
        <AuthProvider>
          <MobileBridgeRunnerPage />
        </AuthProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <AuthProvider>
        <PortalShell />
      </AuthProvider>
    </ErrorBoundary>
  );
}
