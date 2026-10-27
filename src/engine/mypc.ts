// Typed wrapper and standalone fallback for the official My PC SDK
// Loaded via <script src="https://imad-os.github.io/g/sdk/mypc-sdk.js"></script>

export interface MyPCInfo {
  standalone: boolean;
  lang: 'en' | 'fr' | 'es' | 'ar';
  rtl: boolean;
  volume: { music: number; sfx: number };
  profile: { id: string; name: string };
  quality: { tier: 'low' | 'mid' | 'high' };
  app: { id: string };
  bridges?: { net?: number; ai?: number; mic?: number };
}

export interface MyPCInitHandlers {
  onInit: (info: MyPCInfo) => void;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onDestroy: () => void;
  onInput?: (action: string, pressed: boolean, repeat: boolean, dev: string) => void;
  onMenu?: (id: string) => void;
  onVolume?: (v: { music: number; sfx: number }) => void;
  ownMenu?: boolean;
  pad?: boolean | Record<string, unknown>;
}

export interface MyPCGlobal {
  apiLevel?: number;
  app_config: Record<string, any>;
  init: (handlers: MyPCInitHandlers) => void;
  ready: () => void;
  progress: (p: number) => void;
  fail: (reason: string) => void;
  report: (error: unknown, data?: Record<string, unknown>) => void;
  info: () => MyPCInfo;
  isDown: (action: string, dev?: string) => boolean;
  save: (key: string, value: unknown) => void;
  load: <T>(key: string, defaultValue: T) => T;
  submitScore: (score: number, opts?: { player?: string; players?: number }) => void;
  announce: (text: string) => void;
  setMenu: (items: Array<{ id: string; label: string }>) => void;
  pause: () => void;
  exit: () => void;
  gamepad?: {
    on: (
      event: 'button' | 'axes' | 'pads',
      fn: (...args: any[]) => void
    ) => void;
    pressed: (buttonIndex: number, dev?: string) => boolean;
    value: (buttonIndex: number, dev?: string) => number;
    axis: (axisIndex: number, dev?: string) => number;
    name: (buttonIndex: number) => string;
    pads: () => Array<{ dev: string; name: string; standard: boolean; buttons: number; axes: number }>;
  };
  ai?: {
    providers?: () => Promise<any>;
    chat?: (prompt: string, opts?: Record<string, any>) => Promise<{ text?: string } | string>;
    generate?: (req: Record<string, any>) => Promise<any>;
  };
  multiplayer?: {
    supported: boolean;
    host: (opts?: { max?: number }) => Promise<any>;
    join: () => Promise<any>;
  };
}

declare global {
  interface Window {
    MyPC?: MyPCGlobal;
  }
}

export function getMyPC(): MyPCGlobal {
  if (typeof window !== 'undefined' && window.MyPC) {
    return window.MyPC;
  }

  // Fallback shim ONLY when CDN script is blocked in offline/hermetic container
  const downMap: Record<string, boolean> = {};
  const defaultInfo: MyPCInfo = {
    standalone: true,
    lang: 'en',
    rtl: false,
    volume: { music: 0.7, sfx: 0.8 },
    profile: { id: 'local-caretaker', name: 'Keeper' },
    quality: { tier: 'high' },
    app: { id: 'abyssal-evo' },
  };
  let savedHandlers: MyPCInitHandlers | null = null;

  const fallback: MyPCGlobal = {
    apiLevel: 11,
    app_config: {
      allow_background_running: true,
      timeMultiplier: 1,
      defaultTankTier: 0,
      screensaverIdleSeconds: 90,
      startingCredits: 250,
    },
    init(handlers: MyPCInitHandlers) {
      savedHandlers = handlers;
      setTimeout(() => {
        handlers.onInit(defaultInfo);
      }, 0);
    },
    ready() {
      if (savedHandlers) {
        savedHandlers.onStart();
      }
    },
    progress() {},
    fail(reason: string) {
      console.error('[MyPC.fail]', reason);
    },
    report(err: unknown) {
      console.warn('[MyPC.report]', err);
    },
    info() {
      return defaultInfo;
    },
    isDown(action: string) {
      return !!downMap[action];
    },
    save(key: string, value: unknown) {
      try {
        localStorage.setItem(`mypc:abyssal-evo:${key}`, JSON.stringify(value));
      } catch {
        // ignore quota errors
      }
    },
    load<T>(key: string, defaultValue: T): T {
      try {
        const raw = localStorage.getItem(`mypc:abyssal-evo:${key}`);
        return raw ? (JSON.parse(raw) as T) : defaultValue;
      } catch {
        return defaultValue;
      }
    },
    submitScore() {},
    announce() {},
    setMenu() {},
    pause() {
      if (savedHandlers) savedHandlers.onPause();
    },
    exit() {},
    gamepad: {
      on() {},
      pressed() {
        return false;
      },
      value() {
        return 0;
      },
      axis() {
        return 0;
      },
      name(i: number) {
        return ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Select', 'Start'][i] || `Button${i}`;
      },
      pads() {
        return [];
      },
    },
  };

  if (typeof window !== 'undefined') {
    window.MyPC = fallback;
  }
  return fallback;
}

export const I18N: Record<
  'en' | 'fr' | 'es' | 'ar',
  Record<string, string>
> = {
  en: {
    titleSub: '3D Living Aquarium · TV Screensaver · Neural Evolution Lab',
    enterAquarium: 'Enter Aquarium Sanctuary',
    screensaverMode: 'TV Screensaver Mode',
    openTrainerLab: 'Open AI Trainer & Offline Service',
    dropFood: 'Feed Pellets',
    spawnFish: 'Hatch Offspring',
    tankShop: 'Tank Shop',
    brainLab: 'Brain & Lineage',
    aiAdvisor: 'AI Biologist',
    screensaverBtn: 'TV Screensaver',
    controlsHint: 'Gamepad: L-Stick Cursor · R-Stick Orbit · B/OK Feed & Select · X Brain · Y Shop · LB/RB Cycle Fish · Select Screensaver',
    pausedTitle: 'Sanctuary Paused',
    resume: 'Resume Sanctuary',
    restart: 'Reset Ecosystem',
    backToTitle: 'Title Screen',
  },
  fr: {
    titleSub: 'Aquarium 3D Vivant · Économiseur TV · Labo Évolution IA',
    enterAquarium: 'Entrer dans le Sanctuaire',
    screensaverMode: 'Mode Économiseur TV',
    openTrainerLab: 'Ouvrir Labo IA & Service Hors-Ligne',
    dropFood: 'Nourrir',
    spawnFish: 'Éclore',
    tankShop: 'Boutique Bassins',
    brainLab: 'Cerveau & Lignée',
    aiAdvisor: 'Biologiste IA',
    screensaverBtn: 'Économiseur TV',
    controlsHint: 'Manette: Stick-G Curseur · Stick-D Caméra · B/OK Nourrir · X Cerveau · Y Boutique · LB/RB Poisson Suivant',
    pausedTitle: 'Sanctuaire en Pause',
    resume: 'Reprendre',
    restart: 'Réinitialiser',
    backToTitle: 'Écran Titre',
  },
  es: {
    titleSub: 'Acuario 3D Vivo · Salvapantallas TV · Laboratorio Evolutivo IA',
    enterAquarium: 'Entrar al Santuario',
    screensaverMode: 'Modo Salvapantallas TV',
    openTrainerLab: 'Abrir Entrenador IA y Servicio Offline',
    dropFood: 'Alimentar',
    spawnFish: 'Incubar',
    tankShop: 'Tienda de Acuarios',
    brainLab: 'Cerebro y Linaje',
    aiAdvisor: 'Biólogo IA',
    screensaverBtn: 'Salvapantallas TV',
    controlsHint: 'Mando: Stick-I Cursor · Stick-D Cámara · B/OK Alimentar · X Cerebro · Y Tienda · LB/RB Cambiar Pez',
    pausedTitle: 'Santuario en Pausa',
    resume: 'Reanudar',
    restart: 'Reiniciar Ecosistema',
    backToTitle: 'Pantalla de Título',
  },
  ar: {
    titleSub: 'حوض أسماك ثلاثي الأبعاد · شاشة توقف للتلفاز · مختبر تطور الذكاء الاصطناعي',
    enterAquarium: 'دخول محمية الأكواريوم',
    screensaverMode: 'وضع شاشة التوقف للتلفاز',
    openTrainerLab: 'فتح مدرب الذكاء الاصطناعي والخدمة الخلفية',
    dropFood: 'إطعام الأسماك',
    spawnFish: 'فقس جيل جديد',
    tankShop: 'متجر الأحواض',
    brainLab: 'الدماغ والسلالة',
    aiAdvisor: 'المستشار البيولوجي',
    screensaverBtn: 'شاشة التوقف',
    controlsHint: 'ذراع التحكم: العصا اليسرى للمؤشر · اليمنى للكاميرا · B/OK إطعام · X الدماغ · Y المتجر',
    pausedTitle: 'توقف مؤقت',
    resume: 'استئناف',
    restart: 'إعادة ضبط النظام البيئي',
    backToTitle: 'الشاشة الرئيسية',
  },
};
