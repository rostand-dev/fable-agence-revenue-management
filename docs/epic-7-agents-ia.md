# Épic 7 — Agents IA

Blueprint E7 : US-070 (passerelle multi-fournisseur à sorties JSON), US-071 (Market Analyst avec preuves référencées), US-072 (Pricing Strategist et Distribution Manager), US-073 (Revenue Auditor indépendant), US-074 (versions de prompts, budget, traces, repli), US-075 (golden cases en CI sans écriture externe). Ce document est le plan d'implémentation et la référence fonctionnelle de l'épic ; chaque US le complète.

**Point de départ (fin d'épic 6).** Le moteur déterministe détecte, diagnostique, simule, audite et ordonne déjà tout (épics 5 et 6). Le modèle de langage n'intervient que pour rédiger la synthèse du dossier (`narrative.ts`) et pour la conversation avec un agent (`chat.ts`), via l'appel direct `callLlm`. Il n'existe ni schéma de sortie imposé, ni second fournisseur, ni version de prompt tracée par tâche, ni budget, ni jeu de cas de référence.

## Principes de l'épic

1. **Un modèle rédige, classe et commente ; il ne calcule aucun montant et n'écrit nulle part** (ADR-005). Les montants, les planchers, les vetos et la sélection de l'option restent ceux du moteur. Un agent IA ajoute un *avis* au dossier, jamais une valeur.
2. **Toute sortie est une donnée validée** : objet JSON conforme à un schéma, avec des références de preuves vérifiées une à une ; sinon l'avis est écarté et le dossier garde sa version déterministe.
3. **Repli permanent** : sans clé, sans budget, en cas de panne ou de sortie invalide, la revue et les garde-fous fonctionnent à l'identique (comportement des épics 5 et 6, protégé par le test golden `review-golden.test.ts`).
4. **Aucune écriture externe** : les modules d'agents n'importent aucun adaptateur d'écriture ; un test de CI le vérifie (US-075).

## Ordre d'implémentation et dépendances

| Ordre | US | Pourquoi à cette place |
|---|---|---|
| 1 | **US-070** Passerelle multi-fournisseur à sorties JSON | Socle : tout agent passe par elle (schéma, repli, masquage). |
| 2 | **US-074** Versions de prompts, budget, traces, repli | Cadre commun des agents : sans lui, chaque agent réinventerait versions, budget et traces. Il précède les agents pour qu'ils naissent déjà tracés et bornés. |
| 3 | **US-071** Market Analyst | Premier agent : il définit la notion de *preuve référencée*, réutilisée par les suivants. |
| 4 | **US-072** Pricing Strategist et Distribution Manager | Lisent les preuves et les options du moteur ; réutilisent le même contrat de validation. |
| 5 | **US-073** Revenue Auditor indépendant | Relit les avis précédents sans les connaître ; il ne peut qu'alerter, jamais lever un veto. |
| 6 | **US-075** Golden cases en CI | Dernier : fige le comportement de tous les agents et prouve l'absence d'écriture externe. |

**Garde-fou de non-régression** : `review-golden.test.ts` (sortie de `reviewProperty` sur les logements de démo) reste inchangé tout au long de l'épic, ainsi que la suite E2E complète sur trois largeurs (bureau, 390 et 360 px).

## Décisions prises pendant l'épic (à relire)

- **« Multi-fournisseur »** : Anthropic reste le fournisseur du propriétaire (clé saisie dans Intégrations, décision du 17/11). Un **repli OpenAI du serveur** est ajouté, désactivé par défaut : il n'est actif que si `OPENAI_API_KEY` et `OPENAI_MODEL` sont tous deux renseignés (aucun nom de modèle n'est deviné). Il ne remplace jamais la clé d'un propriétaire.
- **Les agents ajoutent des avis, ils ne changent pas la décision** : montants, option retenue et vetos restent déterministes. Aucune sortie de modèle ne peut modifier le champ `selected` d'un dossier.
- **L'auditeur LLM est une seconde lecture** : il peut ajouter une alerte (validation humaine), jamais lever un veto ni approuver une option rejetée (US-073).

## US-070 — Passerelle multi-fournisseur à sorties JSON

**Ce qui change**
- **Module `src/lib/agents/gateway.ts`** : une seule fonction, `generateJson(cibles, appel)`, qui renvoie `{ ok: true, data, meta }` ou `{ ok: false, kind, message, meta }` — jamais d'exception. `data` est le seul contenu du modèle qui sorte du module, et il a passé le schéma Zod de l'appelant.
- **Fournisseurs** (`LlmProvider`) : Anthropic (transport existant `callLlm`, mêmes messages d'erreur), OpenAI (mode JSON, repli facultatif du serveur) et un fournisseur **scripté** (aucun réseau) pour les tests et les golden cases.
- **Cibles ordonnées** : Anthropic (clé du propriétaire, sinon clé du serveur) puis le repli OpenAI s'il est configuré. Une panne de fournisseur ou une sortie invalide fait passer à la cible suivante.
- **Sortie JSON** : le schéma attendu est décrit au modèle ; la réponse est lue même entourée de texte ou d'un bloc de code ; une sortie invalide déclenche **une seule** demande de correction, qui donne la raison du refus mais jamais la réponse refusée (elle pourrait reprendre du contenu non fiable) ; une réponse coupée par la limite de longueur n'est pas corrigée. Plafond d'appels par tâche (4 par défaut).
- **Masquage (US-034)** : e-mails, téléphones, IBAN, cartes et secrets sont masqués avant l'appel, quel que soit le fournisseur.
- **Confidentialité du repli** : le repli n'est tenté qu'après une vraie panne (réseau, 5xx, 429) ou une sortie inexploitable. Une clé de propriétaire **refusée** (401/403) n'envoie jamais ses données vers un autre fournisseur. Activer le repli, c'est ajouter OpenAI comme sous-traitant des données (masquées) des dossiers : à décider en connaissance de cause avant de renseigner `OPENAI_API_KEY`.
- **Bornes** : délai total par tâche (45 s), 20 départs d'analyse et 64 Ko lus au plus dans une réponse, correction et messages d'erreur sans contenu venu du modèle.
- **Page Intégrations** : la carte « Modèle de langage » affiche une ligne « Repli en cas de panne » (aucun ou OpenAI et son modèle).
- **Staging (Coolify)** : aucune migration. Deux variables d'environnement facultatives, toutes deux vides par défaut : `OPENAI_API_KEY` et `OPENAI_MODEL` (le repli n'est actif que si les deux sont renseignées). `OPENAI_API_BASE` n'existe que pour les tests. **Sans rien définir, le comportement est identique à aujourd'hui.**

**Limites connues** : la conversation (`chat.ts`) et la synthèse (`narrative.ts`) continuent d'utiliser l'appel direct Anthropic ; elles passeront par la passerelle avec US-074. Le coût en jetons n'est pas encore plafonné (US-074).

**Tests** : unitaires (`gateway.test.ts` : lecture JSON, schéma, correction unique, repli entre cibles, plafond d'appels, masquage, aucune fuite de clé), **fonctionnels sur de vraies requêtes HTTP** contre un faux serveur local imitant Anthropic et OpenAI (`fake-llm-server.ts` : clés et modèles transmis, bascule sur panne 529, clé refusée 401, réponse coupée), non-régression (suites complètes, golden inchangé), E2E navigateur (`e2e/passerelle-llm.spec.ts` : carte de la page Intégrations, bureau, mobile 390 et 360 px, sans débordement).
