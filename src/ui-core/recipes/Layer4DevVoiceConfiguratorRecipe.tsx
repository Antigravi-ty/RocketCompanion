import React, { useState } from 'react';
import { Info } from 'lucide-react';
import { PanelContainer, PanelHeader, PanelContent } from '../layout/Panel';
import { PanelFooter } from '../layout/PanelFooter';
import { useAppStore } from '../stores/appStore';
import { useMenuLayoutStore } from '../stores/menuLayoutStore';
import { useScopedStore } from '../stores/storeSnapshotScope';
import { DEFAULT_PANEL_SIZING } from '../tokens/menuLayoutTokens';
import type { StandardSurfaceProps, SurfaceMeta } from '../manifest/surfaceMetaTypes';
import { VoiceChatSettingsSection } from './settings/components/VoiceChatSettingsSection';

export type Layer4DevVoiceConfiguratorRecipeProps = StandardSurfaceProps;

export const SURFACE_META: SurfaceMeta = {
  id: 'layer4-dev-voice-configurator',
  title: 'VOICE CHAT CONFIGURATOR',
  subtitle: 'Developer WebRTC Native Voice Channel & Per-Player Mix',
  description:
    'Configure native WebRTC Opus voice channel, input AEC/NS/AGC processing, 0-250% output gain, and per-player peer mix.',
  icon: 'mic',
  layer: 'layer4',
  menuGroup: 'menu-layer',
  defaultSizing: {
    mode: 'adaptive',
    width: DEFAULT_PANEL_SIZING['layer4-dev-voice-configurator'].width,
    height: DEFAULT_PANEL_SIZING['layer4-dev-voice-configurator'].targetHeight,
    minHeight: DEFAULT_PANEL_SIZING['layer4-dev-voice-configurator'].minHeight,
    maxHeight: DEFAULT_PANEL_SIZING['layer4-dev-voice-configurator'].maxHeight,
  },
};

export const Layer4DevVoiceConfiguratorRecipe: React.FC<Layer4DevVoiceConfiguratorRecipeProps> = ({
  isLight = false,
  onBack: propOnBack,
}) => {
  const goBack = useScopedStore('appStore', useAppStore, (s) => s.goBack);
  const [hoveredDesc, setHoveredDesc] = useState<string | null>(null);
  const onBack = propOnBack ?? goBack;

  const sizing = useMenuLayoutStore(
    (s) =>
      s.panels?.['layer4-dev-voice-configurator'] ??
      DEFAULT_PANEL_SIZING['layer4-dev-voice-configurator']
  );

  return (
    <PanelContainer isLight={isLight} sizing={sizing} className="w-full">
      <PanelHeader title="VOICE CHAT CONFIGURATOR" onBack={onBack} isLight={isLight} />

      <PanelContent scrollable>
        <VoiceChatSettingsSection
          bordered={false}
          onHover={setHoveredDesc}
          onLeave={() => setHoveredDesc(null)}
          isLight={isLight}
        />
      </PanelContent>

      <PanelFooter
        isLight={isLight}
        defaultDescription="WebRTC Voice Chat Configurator: Enable microphone, tune AEC/NS/AGC, boost output 0%-250%, and mix individual room peers."
        hoveredDescription={hoveredDesc}
        icon={<Info className="h-3.5 w-3.5 text-neutral-400 shrink-0" />}
      />
    </PanelContainer>
  );
};

Layer4DevVoiceConfiguratorRecipe.displayName = 'Layer4DevVoiceConfiguratorRecipe';
export default Layer4DevVoiceConfiguratorRecipe;
