/**
 * Parcours de création d'un logement (funnel) en six étapes.
 * L'avancement se déduit des données du logement ; la colonne `onboarding` ne garde que l'étape où reprendre,
 * les étapes validées sans donnée obligatoire (règles de vente) et celles reportées « à faire plus tard ».
 */
export const FUNNEL_STEPS = [
  { key: "logement", label: "Le logement" },
  { key: "superhote", label: "SuperHote" },
  { key: "pricelabs", label: "PriceLabs" },
  { key: "regles", label: "Règles de vente" },
  { key: "couts", label: "Coûts et seuils" },
  { key: "verification", label: "Vérification" },
] as const;
export type StepKey = (typeof FUNNEL_STEPS)[number]["key"];
export type StepStatus = "done" | "skipped" | "current" | "todo";
export type OnboardingState = { step: string; reached?: string; done?: string[]; skipped?: string[]; savedAt?: string | null; completedAt?: string | null };

/** Ce dont le calcul a besoin, sans dépendre de la base. */
export type FunnelFacts = {
  identityOk: boolean;
  superhoteLinked: boolean;
  pricelabsLinked: boolean;
  economicsMissing: number;
  onboarding: OnboardingState | null | undefined;
};

export const isStep = (s: unknown): s is StepKey => FUNNEL_STEPS.some((x) => x.key === s);
export const stepIndex = (k: StepKey) => FUNNEL_STEPS.findIndex((x) => x.key === k);
export const stepLabel = (k: StepKey) => FUNNEL_STEPS[stepIndex(k)].label;
export const nextStep = (k: StepKey): StepKey => FUNNEL_STEPS[Math.min(stepIndex(k) + 1, FUNNEL_STEPS.length - 1)].key;
export const prevStep = (k: StepKey): StepKey | null => (stepIndex(k) > 0 ? FUNNEL_STEPS[stepIndex(k) - 1].key : null);

/** Une étape est terminée par ses données quand il y en a ; sinon par sa validation enregistrée. */
export function isDone(k: StepKey, f: FunnelFacts): boolean {
  const done = f.onboarding?.done ?? [];
  switch (k) {
    case "logement": return f.identityOk;
    case "superhote": return f.superhoteLinked;
    case "pricelabs": return f.pricelabsLinked;
    case "regles": return done.includes("regles");
    case "couts": return f.economicsMissing === 0;
    case "verification": return !!f.onboarding?.completedAt;
  }
}
const isSkipped = (k: StepKey, f: FunnelFacts) => !isDone(k, f) && (f.onboarding?.skipped ?? []).includes(k);

/** Étape où reprendre : celle enregistrée, sinon la première ni terminée ni reportée (logements créés avant le funnel). */
export function resumeStep(f: FunnelFacts): StepKey {
  const saved = f.onboarding?.step;
  if (isStep(saved)) return saved;
  return FUNNEL_STEPS.find((s) => s.key !== "verification" && !isDone(s.key, f) && !isSkipped(s.key, f))?.key ?? "verification";
}

/** Ce qui empêche de lancer l'observation. PriceLabs est obligatoire : sans calendrier, aucune revue n'est possible. */
export function launchBlockers(f: FunnelFacts): StepKey[] {
  const b: StepKey[] = [];
  if (!f.identityOk) b.push("logement");
  if (!f.pricelabsLinked) b.push("pricelabs");
  if (f.economicsMissing > 0) b.push("couts");
  return b;
}

export type StepView = { key: StepKey; label: string; index: number; status: StepStatus; reachable: boolean };
/** Frise du parcours, vue depuis l'étape affichée. Une étape est accessible si elle est terminée, reportée, ou au plus loin atteint. */
export function funnelView(f: FunnelFacts, current: StepKey): StepView[] {
  const reached = f.onboarding?.reached;
  const furthest = Math.max(stepIndex(resumeStep(f)), stepIndex(current), isStep(reached) ? stepIndex(reached) : 0);
  return FUNNEL_STEPS.map((s, i) => {
    const done = isDone(s.key, f), skipped = isSkipped(s.key, f);
    const status: StepStatus = s.key === current ? "current" : done ? "done" : skipped ? "skipped" : "todo";
    return { key: s.key, label: s.label, index: i + 1, status, reachable: done || skipped || i <= furthest };
  });
}

/**
 * Nouvel état après une action sur une étape. « next » valide l'étape et mène à la suivante, ou revient à l'étape
 * la plus avancée déjà atteinte (on corrige une étape antérieure depuis la vérification, on y retourne ensuite).
 */
export function advance(prev: OnboardingState | null | undefined, at: StepKey, how: "next" | "skip" | "stay", now = new Date()): OnboardingState {
  const done = new Set(prev?.done ?? []), skipped = new Set(prev?.skipped ?? []);
  if (how === "next") { done.add(at); skipped.delete(at); }
  if (how === "skip") skipped.add(at);
  const before = Math.max(isStep(prev?.reached) ? stepIndex(prev!.reached as StepKey) : 0, isStep(prev?.step) ? stepIndex(prev!.step as StepKey) : 0);
  const target = how === "stay" ? stepIndex(at) : Math.max(stepIndex(nextStep(at)), before);
  const step = FUNNEL_STEPS[target].key;
  const reached = FUNNEL_STEPS[Math.max(before, target, stepIndex(at))].key;
  return { step, reached, done: [...done], skipped: [...skipped], savedAt: now.toISOString(), completedAt: prev?.completedAt ?? null };
}
