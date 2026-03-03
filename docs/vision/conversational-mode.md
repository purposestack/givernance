# Vision — Mode Conversationnel Givernance

> **Givernance NPO Platform** — Du CRM classique au compagnon organisationnel intelligent.
> Dernière mise à jour : 2026-02-28

---

## 1. Pourquoi un mode conversationnel ?

Givernance v1 est un CRM structuré classique : sidebar, modules, formulaires, tableaux. C'est le bon paradigme pour les workflows structurés (saisie de dons, suivi de subventions, gestion de cas).

Mais 80 % des interactions quotidiennes d'un travailleur NPO ne sont pas structurées :
- "Où en est la subvention Fondation Keller ?"
- "Envoie un remerciement à tous les donateurs de la campagne Hiver"
- "Combien de bénéficiaires ont terminé le programme cette année ?"
- "Crée une subvention pour le bailleur EU ERASMUS+ avec 3 tranches"

Ces interactions requièrent aujourd'hui de naviguer entre plusieurs modules, cliquer sur des filtres, ouvrir des formulaires. Un agent conversationnel peut les résoudre en une phrase.

---

## 2. Vision dual-mode

Givernance propose deux paradigmes d'interaction complémentaires :

| Mode | Description | Usage |
|---|---|---|
| **GUI IA-augmenté** | Interface classique (sidebar, modules, formulaires) enrichie par des suggestions IA inline (cf. [docs/13-ai-modes.md](../13-ai-modes.md)) | Workflows structurés, saisie de données, rapports, configuration |
| **Mode conversationnel** | Interface agentique : chat en langage naturel, composants invocables, orchestration d'actions | Requêtes ad-hoc, questions transversales, actions multi-étapes, insights proactifs |

Les deux modes coexistent. L'utilisateur bascule librement entre eux selon le contexte. Le mode conversationnel n'est pas un remplacement du GUI — c'est une couche d'accès supplémentaire au même système.

---

## 3. Architecture à 3 couches d'interaction

```
Couche 1 — Agent conversationnel                  (~80 % des interactions futures)
  Chat en langage naturel, compréhension du contexte org,
  réponses inline (graphiques, tableaux, formulaires pré-remplis),
  orchestration d'actions multi-étapes.

Couche 2 — Vues contextuelles générées à la demande  (~15 %)
  L'agent invoque des composants UI ciblés : un mini-kanban,
  un graphique de tendance, un formulaire pré-rempli — affichés
  inline dans la conversation ou en split-view.

Couche 3 — Modules complets / mode expert            (~5 %)
  Accès au GUI classique pour les workflows complexes :
  configuration admin, migration, audit détaillé,
  saisie massive de données.
```

### Principes de la couche 1

- **Contexte organisationnel** : l'agent connaît la structure de l'ONG, ses programmes, ses bailleurs, ses habitudes.
- **Langage naturel** : pas de syntaxe spéciale, pas de commandes à mémoriser.
- **Actions multi-étapes** : l'agent peut chaîner la création d'une subvention, ses tranches, et le lien bailleur en une seule conversation.
- **Confirmation avant action** : toute action modifiant des données nécessite une validation utilisateur explicite.

### Principes de la couche 2

- **Composants invocables** : chaque widget UI (graphique, tableau, formulaire) est un composant que l'agent peut instancier et injecter dans la conversation.
- **Données synchronisées** : les composants affichés dans la conversation reflètent les mêmes données que le GUI classique.
- **Vue hybride** : mode split 40/60 (conversation + données structurées) pour les tâches nécessitant les deux paradigmes.

### Principes de la couche 3

- **Toujours accessible** : le GUI classique reste disponible à tout moment.
- **Lien bidirectionnel** : l'agent peut proposer "Ouvrir dans le module complet" ; le GUI peut relancer une conversation contextualisée.

---

## 4. Composants invocables par l'agent

L'agent peut générer et afficher les composants suivants dans la conversation :

| Composant | Exemple d'invocation |
|---|---|
| Graphique SVG inline | "Montre-moi l'évolution des dons sur 12 mois" |
| Tableau de données | "Liste les subventions actives avec leur solde" |
| Formulaire pré-rempli | "Crée un don de 500 EUR pour Sophie Renard" |
| Mini-kanban | "Où en sont mes subventions en pipeline ?" |
| Timeline d'actions | "Que s'est-il passé sur le dossier Amara Diallo ?" |
| Carte de confirmation | "Envoie un email de relance à 12 donateurs inactifs" |
| Indicateur KPI | "Quel est le taux de rétention donateurs cette année ?" |

Ces composants sont les mêmes que ceux du GUI classique, invoqués via une couche d'abstraction permettant leur affichage inline dans le flux conversationnel.

---

## 5. Garde-fous et sécurité

Les mêmes garde-fous que les modes IA (cf. [docs/13-ai-modes.md](../13-ai-modes.md)) s'appliquent :

- **Aucune action irréversible sans confirmation** : suppression, envoi massif, modification financière.
- **Données bénéficiaires** : traitées exclusivement par le modèle local EU.
- **Audit complet** : chaque action de l'agent est tracée dans `ai_actions`.
- **Permissions respectées** : l'agent ne peut pas dépasser les droits du rôle de l'utilisateur.
- **Journal d'activité** : historique consultable de toutes les interactions et actions de l'agent (cf. CONV-005).

---

## 6. Roadmap en 3 phases

### Phase 1 — Fondations (2026 H2)
- Palette de commandes augmentée (CONV-007) : recherche + suggestions IA contextuelles
- Dashboard enrichi par copilote IA flottant (CONV-011)
- Requêtes de lecture en langage naturel ("Combien de dons ce mois ?")

### Phase 2 — Orchestration (2027)
- Hub conversationnel complet (CONV-001)
- Résultats inline : graphiques, tableaux, formulaires dans la conversation (CONV-002)
- Orchestration d'actions multi-étapes (CONV-003)
- Confirmation avant action pour les opérations sensibles (CONV-004)
- Vue hybride split-view (CONV-006)
- Journal d'activité de l'agent (CONV-005)

### Phase 3 — Autonomie contrôlée (2027-2028)
- Permissions agent granulaires (CONV-008)
- Onboarding conversationnel (CONV-009)
- Interface mobile-first conversationnelle (CONV-010)
- Insights proactifs : l'agent alerte l'utilisateur de situations nécessitant attention
- Multi-agents spécialisés par domaine (fundraising, programmes, bénévoles)

---

## 7. Positionnement compétitif

Aucun CRM associatif ne propose aujourd'hui d'interface conversationnelle agentique :

- **Salesforce NPSP** : IA limitée à Einstein (scoring prédictif), pas de mode conversationnel.
- **Bloomerang, Little Green Light** : zéro IA.
- **HubSpot for Nonprofits** : ChatSpot existe mais pas intégré aux workflows NPO.

Givernance serait le premier CRM associatif à proposer un **dual-mode natif** : GUI structuré + agent conversationnel, avec les mêmes garde-fous RGPD et la même profondeur fonctionnelle. Ce positionnement cible les ONG qui veulent réduire leur charge administrative de 60 % sans sacrifier le contrôle humain.

---

## 8. Mockups de référence

Les 11 écrans exploratoires du mode conversationnel sont consultables :
- **GitHub Pages** : [Mode conversationnel — Mockups](https://onigam.github.io/givernance/design/conversational-mode/index.html)
- **Local** : `docs/design/conversational-mode/`

Ces mockups sont une exploration prospective (vision 2026-2028), pas une spécification de développement immédiat.

---

*Document lié à : [13-ai-modes.md](../13-ai-modes.md) · [11-design-identity.md](../11-design-identity.md) · [14-screen-inventory.md](../14-screen-inventory.md)*
