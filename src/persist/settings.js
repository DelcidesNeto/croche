const SETTINGS_KEY = 'croche-livre:configuracoes';

export const DEFAULT_SETTINGS = {
  // Taxa de acompanhamento da agulha: menor = mais suave, maior = mais direta.
  followRate: 20,
  pullGuide: true,
  stitchNames: true,
};

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY)) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
