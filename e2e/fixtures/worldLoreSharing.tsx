import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorldLoreModal } from '../../src/components/WorldLoreModal';
import { useAppStore } from '../../src/store/useAppStore';
import '../../src/index.css';

localStorage.removeItem('nn_world_lore_drafts');
useAppStore.setState({ worldLoreModalOpen: true, worldLoreDrafts: [], worldLoreActiveDraftId: null });
createRoot(document.getElementById('root')!).render(<React.StrictMode><WorldLoreModal /></React.StrictMode>);
