# REC BLUE — plugin de marque (`RecBlueBranding`)

Plugin BepInEx pour le client Rec Room 2023 installé dans `C:\RecRoom2023`.
Il change l'apparence de l'interface au lancement, et rien d'autre.

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
Le cadre d'origine est conservé (`preserveAspect = true`), sans agrandissement.

Journal : `titre REC BLUE charge : <largeur>x<hauteur>` puis
`marque : N sprite(s) remplace(s).`

### 2. Le bleu

Le bleu ne s'applique qu'à **deux familles d'éléments** :

- les **textes** : composants `Text`, `TextMeshPro*`, `TMP_*`, et les `TextMesh` 3D du
  MakerPen ;
- les **aplats du tableau d'accueil** uniquement, c'est-à-dire tout ce qui vit sous un
  ancêtre nommé `CommunityBoard` (ou `tableau`).

Rien d'autre n'est teint : ni les boutons, ni les panneaux généraux, ni les icônes.
Les étoiles de notation gardent leur doré (garde-fou dans la détection de l'orange).

Journal : `teintes : N element(s) passe(s) en bleu`, `textes 3D : N`.

### 3. La cadence (réglages de performance, pas de rendu)

| Réglage | Valeur posée | Effet |
| --- | --- | --- |
| `QualitySettings.vSyncCount` | `0` | pas de synchronisation verticale |
| `Application.targetFrameRate` | fréquence de l'écran (`240` ici) | plafond calé sur l'affichage, pas au-delà |
| `QualitySettings.maxQueuedFrames` | `2` (valeur du moteur) | pipeline CPU/GPU non bloqué |
| priorité du processus | `High` | priorité Windows |

Journal : `perf : vsync X -> 0`, `perf : plafond fps illimite -> 240 (ecran 240 Hz)`,
`perf : maxQueuedFrames 1 -> 2 (pipeline)`, `perf : priorite process = High`,
`perf : priorite remise a High (le jeu l'avait baissee)`.

Aucune passe ne bloque une frame : la recherche du logo est parcourue par tranches de
0,30 ms (avec une seule passe profonde, pendant le chargement, parce que les gabarits
inactifs portent le sprite d'origine), la teinte travaille avec le même budget, et les
énumérations en régime normal ne portent que sur les objets actifs. Une énumération ou
un bloc de balayage qui dépasse 20 ms est signalé dans le journal.

À noter : le plugin expose aussi une sonde `fpsprobe` (`N fps | pire frame X ms |
frames lentes Y`) sur une vingtaine d'échantillons de 5 s, pour mesurer sans supposer.

### 4. La console

Les appels du client 2023 vers des services morts sont masqués **dans la console
uniquement**, par un préfixe Harmony sur le répartiteur de logs de BepInEx. Motifs
filtrés : `HTTP Error`, `Failed to retrieve strings`, `trying to download strings`,
`Response was empty`, `Gamesight`, `Unknown Material guid`,
`Could not find an entry with key`, `Processing queued table`.

Les vraies exceptions et les erreurs du plugin ne sont pas filtrées, et `Player.log`
garde l'intégralité des messages du jeu.

Journal : `console : filtre reseau actif.` puis `console : N ligne(s) reseau masquee(s).`

### 5. Le garde-fou qualité

Au chargement, le plugin photographie les réglages **visuels** ; toutes les 2 s il les
compare et remet la valeur d'origine si l'une a bougé : ombres (qualité, résolution,
projection, distance), anti-aliasing, taille des textures, filtrage anisotrope, LOD,
lumières par pixel, particules douces, reflets temps réel.

Les réglages de **cadence** (`vSyncCount`, `targetFrameRate`, `maxQueuedFrames`) en sont
exclus : ce ne sont pas des réglages visuels. La résolution d'écran est seulement
signalée si elle change, jamais forcée.

Journal : `qualite : verrouillee (ombres=…, AA=…, mip=…, LOD=…, lumieres=…, LxH)`.
Une remise en place écrit `qualite : <champ> remis au reglage d'origine`.

### 6. Le panneau de login

La ligne de sélection de langue est replacée sous « CHANGER DE COMPTE »
(`login : selecteur de langue place sous CHANGER DE COMPTE`). Le fond, les boutons et
les couleurs du login restent ceux du jeu.

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
| `RECBLUE_SAFE.txt` | Branding entièrement neutralisé (titre, bleu) ; les réglages de cadence restent. Sert à savoir si un problème vient du plugin ou du jeu. |
| `RECBLUE_QUALITE_LIBRE.txt` | Met le garde-fou qualité en veille : le jeu peut changer ses réglages visuels. |
| `RECBLUE_IDLE.txt` | Force le mode veille après 45 s. |
| `RECBLUE_DUMP.txt` | **Inerte** : la sonde de diagnostic a été supprimée. |

## Journal

Lignes attendues au lancement :

```
REC BLUE 2.6.0 : plugin charge (vsync off, plafond ecran, priorite high).
console : filtre reseau actif.
qualite : verrouillee (ombres=All, AA=4, mip=0, LOD=2,0, lumieres=4, 2560x1440)
titre REC BLUE charge : 1673x935
marque : 4 sprite(s) remplace(s).
reglage : mode=branding (textures=False, planches<=512 px)
perf : maxQueuedFrames 1 -> 2 (pipeline)
perf : priorite process = High
perf : vsync 1 -> 0
perf : plafond fps illimite -> 240 (ecran 240 Hz)
surveillance : veille active (salve a chaque changement d'ecran, passe de securite toutes les 30 s).
```

## Désinstallation

Fermer le jeu, puis supprimer `BepInEx\plugins\RecBlueBranding.dll`. Le client retrouve
son apparence d'origine au lancement suivant : le plugin ne laisse aucune trace dans les
fichiers du jeu.
