# REC BLUE — plugin de marque (`RecBlueBranding`)

Plugin BepInEx pour le client Rec Room 2023 installé dans `C:\RecRoom2023`.
Il change l'apparence de l'interface au lancement, et rien d'autre.

> **État courant :** le plugin fait deux choses — remplacer le logo/titre Rec Room par
> REC BLUE sur l'écran de login et sur l'écran de chargement (y compris la vignette de
> chargement de salle), et teinter les panneaux du **tableau d'accueil** de la Dorm Room.
> Tout le reste est éteint : plus de bleu des textes, plus de filtre de console, plus de
> verrouillage des réglages visuels, plus de réglage de cadence (vsync, priorité, fps),
> aucun autre panneau du jeu n'est repeint. Le splash d'amorçage garde le mot-symbole
> Rec Room d'origine.

### 0. Mode titre seul

Les commutateurs en tête de `Plugin.cs` commandent tout le plugin :

| Commutateur | Valeur | Effet |
| --- | --- | --- |
| `EnableLogoBranding` | `true` | logo REC BLUE au login |
| `EnableLoadingTitle` | `true` | logo REC BLUE sur les écrans de chargement |
| `EnableBoardTint` | `true` | panneaux du tableau d'accueil teintes (et eux seuls) |
| `EnableBlueUi` | `false` | aucun texte teinté |
| `EnablePanelTinting` | `false` | teinte limitée au tableau (pas aux autres panneaux) |
| `EnableWatchTransparency` | `false` | Watch jamais touché |
| `EnableYoutubeButton` | `false` | bouton « YouTube » coupé (on oublie ce truc) |
| `EnableBoardLinkButtons` | `true` | boutons Rec Room du tableau repris : libellé REC BLUE + clic vers `recblue.net` |
| `EnableLoginLayout`, `EnableLogoSweep`, `EnableDiagnostics` | `false` | pas de réagencement, pas de balayage |
| `LoadingArt.Enabled` | `false` | visuels de chargement d'origine |

Les appels de cadence (`ApplyPerf`), de filtre de console (`QuietConsole`) et de
garde-fou visuel (`QualityGuard`) sont retirés du chargement : le plugin ne touche
plus ni la cadence, ni la console, ni les réglages graphiques.

- DLL installée : `C:\RecRoom2023\BepInEx\plugins\RecBlueBranding.dll`
- Source : `game-plugin/RecBlueBranding/Plugin.cs`
- Compilation :

```sh
DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 ./.tools/dotnet/dotnet.exe build \
  game-plugin/RecBlueBranding/RecBlueBranding.csproj -c Release -v m
```

La DLL produite est `bin/Release/net6.0/RecBlueBranding.dll` ; elle doit être copiée
dans `BepInEx/plugins` **jeu fermé** (sinon « Device or resource busy »).

## Ce que le plugin change

### 1. Le logo

Les sprites dont le nom commence par `RecRoomLogo`, `RecRoom_Logo`,
`Illustration_RecRoomLogo` ou qui sont les splash Steam / Oculus / VR sont remplacés par
l'image embarquée `RecBlueTitle.png` (`1673x935`, contour blanc, fond transparent).
Le cadre d'origine est conservé (`preserveAspect = true`). Sur l'écran de login
uniquement, le logo est mis **à la largeur du logo Rec Room qu'il remplace** : mesure
faite sur une capture du jeu sans branding, 248 px de large contre 227 px au repos, soit
un rapport de 1.09. Deux images imbriquées portant le logo composent leurs échelles
(k × k), d'où `LoginLogoScale = 1.045` appliqué au `localScale`. Sur l'écran de
chargement, seuls les grands logos compatibles sont remplacés ; les petits onglets et
icônes gardent le logo d'origine.

Le logo est aussi reconnu par le **nom des objets** quand le sprite n'a pas un nom
parlant : `[Icon] Rec Room Logo / Image - Change Icon Here`, sur l'écran de login comme
sur l'écran de chargement (`Title Loading Screen`). Une `RawImage` de logo, si elle
existe, reçoit directement la texture du titre. Le remplacement est relancé dès qu'un
nouvel écran apparaît, puis vérifié toutes les 120 ms sur les logos déjà vus : comme le
client reconstruit son logo en boucle au démarrage, il repasse en REC BLUE aussitôt et
le logo d'origine n'a plus le temps de s'installer.

La correction du signe `%` des écrans de chargement est retirée (plus aucun texte
modifié).

Journal : `titre REC BLUE charge : <largeur>x<hauteur>` puis
`marque : N sprite(s) remplace(s).` et, au premier logo de login,
`logo login : taille Rec Room x1.045 (<chemin>)`.

### 2. Le bleu — desactive, sauf le tableau d'accueil

Le bleu des **textes** est coupé (`EnableBlueUi = false`). Seule reste active la teinte
des **aplats du tableau d'accueil**, c'est-à-dire tout ce qui vit sous un ancêtre nommé
`CommunityBoard` (ou `tableau`) : `EnableBoardTint = true`, `EnablePanelTinting = false`.

### Boutons du tableau

`EnableBoardLinkButtons = true` reprend **sur place** tous les boutons du tableau : aucun ne
mène plus chez Rec Room, chacun ouvre `https://recblue.net`.

| Libellé du jeu | Libellé REC BLUE |
| --- | --- |
| `RecRoom Instagram` | `REC BLUE Instagram` |
| `Submit your stuff` | `Propose ton contenu` |
| `Terms of Service` | `CGU` |
| `Privacy Policy` | `Vie privee` |
| `Help` | `Aide` |
| `More Info` | `Plus d'infos` |
| `View Rooms` | `Chambres du jeu` |
| `How to build` | `Construire` |
| `Player highlights` | `Temps forts` |

Rien n'est recréé : la position, la taille et le style restent ceux du jeu, seuls les
écouteurs du bouton sont remplacés. Le libellé est comparé en minuscules et sans espaces
superflus ; les boutons 3D du mur (texte en `TextMesh`) passent par la même table.

Ces boutons ne sont pas des `Button` Unity mais des composants Rec Room (classe interne),
donc aucun écouteur ne peut leur être attaché : les libellés sont réécrits, et le clic est
repris en interceptant l'ouverture de lien du jeu (`Application.OpenURL`, patché par
Harmony). Tout lien Rec Room (`recroom.com`, `zendesk`, Instagram, YouTube, `discord.gg`)
part sur `https://recblue.net` ; le journal écrit `tableau : lien du jeu -> <url>` puis
`tableau : <url> remplace par https://recblue.net`.

`BoardLinkLabelOnly` permet de renommer un bouton **sans** toucher à son clic (il garde son
action en jeu). La table est vide : tous les boutons du tableau sont redirigés. Pour
exceptionner un bouton, y ajouter `{ "libelle jeu", "libelle rec" }` — le journal écrit
alors `tableau : libelle seul "…" -> "…" (clic du jeu conserve, <chemin>)`.

La passe tourne toutes les 3 s pendant les 30 premières secondes (le tableau se construit),
puis toutes les 60 s — le jeu peut reconstruire ses boutons.

Le balayage est **limité aux deux panneaux** `[CommunityBoard]` et `[HelpButtonsCanvas]`
(descente de leur arbre). Un `FindObjectsOfType` sur toute la scène coûtait 13 à 26 ms de
thread principal par passe, soit un à-coup visible toutes les 2 s : c'est mesuré, et c'est
la raison de ce découpage. Un balayage large n'a lieu qu'au démarrage, tant que les
panneaux n'existent pas (30 s au plus). Une passe de plus de 8 ms écrit
`tableau : passe N ms` dans le journal. Elle journalise une fois les
libellés qu'elle voit (`tableau : libelles vus (...)`) : si un bouton porte un autre nom
que ceux listés ci-dessus, c'est cette ligne qui le dit, et il suffit d'ajouter le couple
libellé/replacement dans `BoardLinkTargets`.
Les fonctions de teinte sortent immédiatement pour tout élément hors du tableau.

Rien d'autre n'est teint : ni les textes, ni les boutons, ni les panneaux généraux, ni
les icônes, ni le panneau Watch (sa transparence est désactivée).

Journal : `panneau image : <chemin> <ancienne couleur> -> <nouvelle> ... board=True`.

Journal : `panneaux : N fond(s) passe(s) en bleu` (passe de rattrapage, tableau seul).

### L'image de la recompense du defi

Le panneau du defi de la semaine (`Systems/[CommunityBoard]/WeeklyChallengePanel/
[RewardDisplay]`) affiche l'objet a gagner. Cette image-la est dessinee par le client :
aucun champ du serveur ne la porte. `EnableRewardLogo = true` remplace le visuel par le
logo REC BLUE (`RecBlueRewardLogo.png`, le logo carre du site, embarque). Seul le **plus
grand visuel non textuel** de `[RewardDisplay]` est change — c'est l'image de l'objet ; le
cadre, le fond et le libelle « Recompense REC BLUE » gardent leur place et leur style.
L'image est remise a chaque passe du tableau (3 s puis 60 s), donc elle ne revient pas au
skin du jeu si le client redessine le panneau.

Journal : `defi : image de la recompense remplacee par le logo REC BLUE (<chemin>)`.

### 3. La cadence — desactivee (plus aucun réglage de performance)

| Réglage | Valeur posée | Effet |
| --- | --- | --- |
| `QualitySettings.vSyncCount` | `0` | pas de synchronisation verticale |
| `Application.targetFrameRate` | `-1` (illimité) par défaut (`RECBLUE_FPS.txt` pour plafonner) | aucune limite imposée par le plugin ; le GPU/CPU décident |
| `QualitySettings.maxQueuedFrames` | `2` (valeur du moteur) | pipeline CPU/GPU non bloqué |
| priorité du processus | `High` | priorité Windows |

Journal : `perf : vsync X -> 0`, `perf : plafond fps 120 -> illimite (ecran 240 Hz)`,
`perf : maxQueuedFrames 1 -> 2 (pipeline)`, `perf : priorite process = High`,
`perf : priorite remise a High (le jeu l'avait baissee)`.

Aucune passe ne bloque une frame : la recherche du logo est parcourue par tranches de
0,30 ms (avec une seule passe profonde, pendant le chargement, parce que les gabarits
inactifs portent le sprite d'origine), la teinte travaille avec le même budget, et les
énumérations en régime normal ne portent que sur les objets actifs. Une énumération ou
un bloc de balayage qui dépasse 20 ms est signalé dans le journal.

À noter : la sonde `fpsprobe` (`N fps | pire frame X ms | frames lentes Y`) est un
diagnostic **opt-in** : créer `RECBLUE_PROBE.txt` dans `BepInEx/plugins` pour l'activer.
Elle est désactivée par défaut, car elle écrit dans le journal toutes les 5 s et peut
provoquer des à-coups.

### 4. La console — desactivee

Deux filtres complémentaires sont installés :

1. **Répartiteur BepInEx** (services morts du client 2023) : `HTTP Error`,
   `Failed to retrieve strings`, `trying to download strings`, `Response was empty`,
   `Gamesight`, `Unknown Material guid`, `Could not find an entry with key`,
   `Processing queued table`, ainsi que les messages bénins d’environnement
   (`Could not initialize OpenVR`, `Unable to start VR Subsystem`,
   `Missing VolumeProfile on VignetteImageEffect`, `Missing Active Controller`) et les
   scripts de debug absents (`DebugCommandListOnFirstLoginInvoker`, `DebugConsole`).
   Les erreurs de sérialisation répétées (`Error serializing ...`) sont traitées à part :
   la première occurrence de chaque message est conservée, les suivantes sont masquées
   puis résumées toutes les 10 s.
2. **Journalisation Unity** (`Debug.LogWarning/LogError/LogException` et
   `Logger.Log`) : la console du jeu et `Player.log` ne passent pas par BepInEx. Les
   mêmes messages bénins y sont coupés à la source : erreurs HTTP du CDN de chaînes
   (`HTTP Error`, `Failed to retrieve strings`, `trying to download strings`),
   réponses vides (`Response was empty`, `Received blank response when we expected data`),
   événements analytics (`Gamesight`), matériaux manquants (`Unknown Material guid`,
   `Could not find an entry with key`, `Processing queued table`), absence de casque
   (`Could not initialize OpenVR`, `Unable to start VR Subsystem`), avertissements de
   contenu sans incidence (`Missing VolumeProfile on VignetteImageEffect`,
   `Missing Active Controller`) et scripts de debug absents. Ils ne sont donc plus
   écrits dans `Player.log` non plus ; tout le reste y est conservé.

Les vraies exceptions (autres que ce message de collection) et les erreurs du plugin
ne sont pas filtrées. En particulier, `RecNet login failed. StatusCode: 400` reste
visible : c’est un échec de connexion réel, pas un bruit réseau. Le compte 2 est non
banni et son lien Steam existe ; si cette ligne revient, il faut relever la réponse
d’authentification (`error_description`) avant de conclure.

Journal : `console : filtre reseau actif.`, `console : filtre Unity actif (N methode(s)).`
puis `console : N ligne(s) reseau masquee(s), M ligne(s) Unity masquee(s).`

### 5. Le garde-fou qualité — desactive

Au chargement, le plugin photographie les réglages **visuels** ; toutes les 2 s il les
compare et remet la valeur d'origine si l'une a bougé : ombres (qualité, résolution,
projection, distance), anti-aliasing, taille des textures, filtrage anisotrope, LOD,
lumières par pixel, particules douces, reflets temps réel.

Les réglages de **cadence** (`vSyncCount`, `targetFrameRate`, `maxQueuedFrames`) en sont
exclus : ce ne sont pas des réglages visuels. La résolution d'écran est seulement
signalée si elle change, jamais forcée.

Journal : `qualite : verrouillee (ombres=…, AA=…, mip=…, LOD=…, lumieres=…, LxH)`.
Une remise en place écrit `qualite : <champ> remis au reglage d'origine`.

### 6. Le panneau de login — desactive

La ligne de sélection de langue est replacée sous « CHANGER DE COMPTE »
(`login : selecteur de langue place sous CHANGER DE COMPTE`). Le fond, les boutons et
les couleurs du login restent ceux du jeu.

### 7. Le bouton YouTube

Le jeu n'a pas de navigateur intégré : le plugin ajoute donc son propre Canvas en
surimpression (`sortingOrder` 32000) avec un seul bouton de 132×40 px, en bas à droite
(24 px des bords), qui ouvre
`https://www.youtube.com` dans le navigateur de Windows — là où la lecture se fait
avec le son. Rien n'est affiché si `EnableYoutubeButton = false`.

Le Canvas est recréé s'il disparaît (comme les autres gardes) et journalise :

```
youtube : bouton ajoute en bas a droite (ouvre https://www.youtube.com dans le navigateur).
youtube : ouverture de https://www.youtube.com
```

## Ce que le plugin ne touche jamais

- **Aucun fichier du jeu.** Ni bundles, ni `StreamingAssets`, ni catalogue : tout est fait
  à l'exécution sur des objets Unity. Vérifié par empreinte MD5 : les 38 bundles de
  `.backup-aa` sont identiques à ceux du dossier du jeu, et `StreamingAssets\aa` compte
  6502 fichiers avant comme après les essais.
- **Aucune texture.** La conversion de texture est coupée en dur
  (`paintTextures = false` dans `ReadMode`) et l'essai de repeinture du fond de login a
  été retiré : le plugin ne réécrit aucun pixel.
- **Aucun réglage graphique** : voir le garde-fou ci-dessus (qualité d'ombres,
  anti-aliasing, textures, LOD, lumières, reflets).
- **Aucune résolution ni mode d'affichage** : `Screen.SetResolution` n'est jamais appelé.
- **Aucun comportement de jeu** : pas de patche sur le gameplay, les comptes, Photon, le
  réseau, les achats ou les sauvegardes. Le seul patch Harmony porte sur la journalisation
  de BepInEx.
- **Aucun retour arrière caché** : le plugin ne modifie ni les préférences du jeu ni
  `Player.log`.

## Fichiers de contrôle (dans `BepInEx/plugins`)

| Fichier | Effet |
| --- | --- |
| `RECBLUE_MODE.txt` | `mode=fluent`, `balanced` ou `branding`. Relu toutes les 5 s. Les trois donnent aujourd'hui le même résultat : la conversion de textures est coupée. |
| `RECBLUE_FPS.txt` | Absent ou `fps=0` = illimité ; `fps=144` (ou 30–500) = plafond. Relu toutes les 5 s. |
| `RECBLUE_PROBE.txt` | Active la sonde `fpsprobe` (diagnostic, écrit toutes les 5 s). Absente = sonde désactivée, mode de jeu normal. |
| `RECBLUE_SAFE.txt` | Branding entièrement neutralisé (titre, bleu) ; les réglages de cadence restent. Sert à savoir si un problème vient du plugin ou du jeu. |
| `RECBLUE_QUALITE_LIBRE.txt` | Met le garde-fou qualité en veille : le jeu peut changer ses réglages visuels. |
| `RECBLUE_IDLE.txt` | Force le mode veille après 45 s. |
| `RECBLUE_DUMP.txt` | **Inerte** : la sonde de diagnostic a été supprimée. |

## Journal

Lignes attendues au lancement (mode titre seul) :

```
titre : mode titre seul (login et ecrans de chargement).
REC BLUE 3.0.0 : plugin charge (titre seul, aucun autre reglage).
titre loading : image chargee 1094x916.
titre loading : 1 logo(s) remplace(s) par RecBlueTitleWinter.
titre REC BLUE charge : 1673x935
surveillance : veille active (salve a chaque changement d'ecran, passe de securite toutes les 30 s).
```

Aucune ligne `teintes :`, `qualite :`, `perf :` ni `console :` ne doit apparaitre :
leur presence signifierait qu'un des sous-systemes retires a ete rebranche.

## Désinstallation

Fermer le jeu, puis supprimer `BepInEx\plugins\RecBlueBranding.dll`. Le client retrouve
son apparence d'origine au lancement suivant : le plugin ne laisse aucune trace dans les
fichiers du jeu.
