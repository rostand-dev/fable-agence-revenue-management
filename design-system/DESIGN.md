# NuitSignal — design system

## Produit et intention
NuitSignal est un cockpit de revenue management pour la location : il aide à repérer les exceptions, examiner les preuves et arbitrer une action. Le langage « Deep Space » associe un fond nocturne, des surfaces translucides discrètes et des accents lumineux à une présentation analytique dense. Les écrans sources constituent la référence, pas une identité institutionnelle indépendante.

## Couleurs
| Rôle | Valeur | Usage |
|---|---|---|
| Fond profond | `#04050a` | Toile principale |
| Fond secondaire | `#0b0e1a` | Dégradé de fond |
| Surface | blanc 4,5 % | Cartes et regroupements |
| Surface élevée | blanc 7 % | Sélection et survol |
| Trait | blanc 9 % / 16 % | Séparation / accent |
| Texte | `#eef1f8` | Texte principal |
| Secondaire / discret | `#9aa4bf` / `#8b94ad` | Contexte et métadonnées |
| Bleu | `#60a5fa` | Information, lien, sélection |
| Violet | `#a78bfa` | Accent et identité |
| Vert | `#34d399` | Situation saine |
| Ambre | `#fcd34d` | Attention et garde-fou |
| Rose | `#fda4af` | Veto |
| Focus | `#7dd3fc` | Contour clavier |

L’action principale utilise le dégradé `#2563eb` vers `#7c3aed`. Les couleurs d’état sont accompagnées de libellés et de formes : disque sain, losange attention, carré garde-fou, croix veto, barre technique. Le rouge est réservé au veto.

## Typographie
Police système `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` ; chiffres et identifiants en `ui-monospace, "SF Mono", Menlo, monospace`. Le corps source est à 16 px / 1,6 ; titre de page 28 px / 1,25, section 18 px, valeur de métrique 26 px. Les métadonnées et étiquettes denses du produit descendent jusqu’à 11–14 px : les réserver aux informations secondaires, et privilégier 16 px pour les nouveaux textes courants. La marque SVG source utilise Arial pour son mot-symbole.

## Espacement, rayons et profondeur
Rythme principal de 4 et 8 px : 8, 12, 16, 20, 24, 32 et 40 px. Cartes à 20 px de marge interne, contenu à 28–32 px sur grand écran. Rayons 8, 12 et 16 px ; pastilles entièrement arrondies. Bordures fines et surfaces translucides créent la profondeur ; l’ombre forte `0 24px 80px rgb(0 0 0 / 60%)` est réservée aux confirmations.

## Composition
Sur grand écran, rail latéral de 248 px, barre de titre et fil d’Ariane persistants, puis contenu limité à 1180 px. La lecture suit signal observé, période, hypothèse, option proposée. Les métriques précèdent les situations et leurs preuves. Sur petit écran, réorganiser les colonnes, garder les actions accessibles et éviter le défilement horizontal ; les tableaux peuvent disposer de leur propre zone défilante.

## Composants
- **Navigation** : rail groupé, icône linéaire, libellé et état courant ; fil d’Ariane pour le contexte.
- **Boutons** : action principale en dégradé, secondaires sur surface sombre bordée ; états désactivé, survol et focus visibles.
- **Cartes et métriques** : surface translucide, filet fin, valeur et source distinctes.
- **États et tags** : libellé explicite et marque géométrique, jamais la couleur seule.
- **Bannières** : titre et explication contextualisée pour le mode, l’alerte ou la technique.
- **Dossier** : chaîne signal → période → hypothèse → option, éléments de preuve dépliables, tableau économique et chronologie.
- **Formulaires et confirmation** : labels visibles, aide et erreurs proches du champ ; dialogue pour les décisions sensibles.
- **Équipe IA** : portraits fournis, rôle et contribution distincts ; les crédits restent dans `assets/stock/credits.json`.

Les composants originaux et leurs interactions sont préservés dans `examples/source/` et appliqués dans `ui_kits/app/`.

## Mouvement et interaction
Transitions source de 180 ms pour les changements d’état ; survol plus clair, focus clavier bleu clair avec contour de 2 px. Prévoir réduction des animations avec `prefers-reduced-motion`, chemins de fermeture et retour de focus pour les dialogues. Les interfaces restent utilisables au clavier.

## Voix
Français clair, précis et opérationnel. Nommer le signal, sa période et l’hypothèse avant de proposer une décision. Distinguer observation, simulation et fait vérifié ; conserver les sources et qualifications. Ne pas remplacer un montant absent par zéro.

## À éviter
Ne pas employer le rouge pour une simple alerte ; ne pas coder un statut par la couleur seule ; ne pas présenter une simulation comme un résultat certain ; ne pas multiplier les actions principales ; ne pas masquer les preuves, les unités ou les sources. Éviter les effets décoratifs additionnels qui nuisent à la lecture. Le fond cosmique et le dégradé d’action proviennent explicitement du projet source et constituent ici une exception à une esthétique neutre par défaut.

## Product Context
Le cockpit réunit opportunités, dossiers, logements, équipe IA, graphiques, bilan pilote, références et réglages. Sa mission est d’aider à arbitrer des situations de revenu à partir de signaux et de preuves.

## Color
Les couleurs et leurs usages sont détaillés dans la section Couleurs ci-dessus et dans `colors_and_type.css`.

## Typography
La police système et la police monospace, leurs tailles et leurs usages sont décrits dans Typographie.

## Spacing
Le rythme et les rayons sont décrits dans Espacement, rayons et profondeur.

## Components
Les boutons, états, cartes, tableaux, formulaires et éléments de dossier sont décrits dans Composants. Les exemples complets figurent dans `examples/source/`.

## Voice
Une voix française, analytique et prudente distingue fait, hypothèse et simulation.

## Anti-patterns
Éviter l’alerte rouge non critique, les statuts sans libellé, les simulations présentées comme des faits et les données sans source.
