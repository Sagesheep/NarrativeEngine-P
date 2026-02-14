import './index.css';
import { Header } from './components/Header';
import { ContextDrawer } from './components/ContextDrawer';
import { ChatArea } from './components/ChatArea';
import { SettingsModal } from './components/SettingsModal';

export default function App() {
  return (
    <>
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <ContextDrawer />
        <ChatArea />
      </div>
      <SettingsModal />
    </>
  );
}
