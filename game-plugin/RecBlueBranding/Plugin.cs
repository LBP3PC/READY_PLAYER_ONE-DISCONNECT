using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Threading;
using BepInEx;
using Il2CppInterop.Runtime;
using Il2CppInterop.Runtime.InteropTypes.Arrays;
using BepInEx.Logging;
using BepInEx.Unity.IL2CPP;
using UnityEngine;
using UnityEngine.UI;
using TMPro;

namespace RecBlueBranding
{
    // REC BLUE 2.9.4
    // - perf : vsync coupe, fps non plafonnes, priorite process haute ;
    // - marque : sprites du logo remplaces par REC BLUE ;
    // - bleu : palette RRUI + teintes runtime (Graphic.color, ColorBlock) + recoloration
    //   des TEXTURES orange (c'est la que vivaient le bouton JOUER et le fond a motifs).
    // Tout le travail est fait une seule fois au demarrage, puis le plugin se desactive.
    [BepInPlugin("net.recblue.branding", "REC BLUE - marque du jeu", "2.9.4")]
    public class BrandingPlugin : BasePlugin
    {
        internal static ManualLogSource Trace;
        private static System.Threading.Timer titleTimer;
        private static SynchronizationContext titleContext;

        // Mode titre seul : le plugin ne remplace que le logo/titre Rec Room par REC BLUE.
        // Il ne teinte plus les textes, ne filtre plus la console, ne verrouille plus les
        // reglages visuels et ne touche plus a la cadence (vsync, priorite, fps).
        internal static readonly bool EnableLogoBranding = false;
        internal static readonly bool EnableLoginLayout = false;
        internal static readonly bool EnableLogoSweep = false;
        internal static readonly bool EnableDiagnostics = false;
        internal static readonly bool EnableBlueUi = false;
        internal static readonly bool EnablePanelTinting = false;
        internal static readonly bool EnableWatchTransparency = false;
        // Seul le tableau d'accueil (Dorm Room, ancetre CommunityBoard/tableau) recoit la
        // teinte REC BLUE : les autres panneaux du jeu gardent leurs couleurs.
        internal static readonly bool EnableBoardTint = true;
        // Titre des ecrans de login et de chargement : coupe (test de cadence en cours).
        internal static readonly bool EnableLoadingTitle = false;
        // Bouton « YouTube » en surimpression : COUPE a la demande (on oublie ce truc).
        // Le code reste la, inerte ; repasser a true le fait revenir.
        internal static readonly bool EnableYoutubeButton = false;
        private const string YoutubeUrl = "https://www.youtube.com";
        private static GameObject youtubeButtonRoot;

        // ---------------------------------------------------------------- youtube
        // Un Canvas a nous, au-dessus de l'interface du jeu (sortingOrder tres haut), avec un
        // seul bouton. Il est recree si le jeu detruit son Canvas, comme le reste des gardes :
        // l'objet du plugin est desactive apres le chargement initial.
        internal static void EnsureYoutubeButton()
        {
            if (!EnableYoutubeButton || youtubeButtonRoot != null) return;
            try
            {
                GameObject canvasGo = new GameObject("REC BLUE YouTube");
                Canvas canvas = canvasGo.AddComponent<Canvas>();
                canvas.renderMode = RenderMode.ScreenSpaceOverlay;
                canvas.sortingOrder = 32000;
                CanvasScaler scaler = canvasGo.AddComponent<CanvasScaler>();
                scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
                scaler.referenceResolution = new Vector2(1920f, 1080f);
                canvasGo.AddComponent<GraphicRaycaster>();
                UnityEngine.Object.DontDestroyOnLoad(canvasGo);

                GameObject buttonGo = new GameObject("Bouton YouTube");
                buttonGo.transform.SetParent(canvasGo.transform, false);
                Image background = buttonGo.AddComponent<Image>();
                background.color = new Color(0.12f, 0.48f, 0.86f, 0.82f);
                Button button = buttonGo.AddComponent<Button>();
                button.targetGraphic = background;
                RectTransform rect = buttonGo.GetComponent<RectTransform>();
                rect.anchorMin = new Vector2(1f, 0f);
                rect.anchorMax = new Vector2(1f, 0f);
                rect.pivot = new Vector2(1f, 0f);
                rect.anchoredPosition = new Vector2(-24f, 24f);
                rect.sizeDelta = new Vector2(132f, 40f);

                GameObject labelGo = new GameObject("Texte");
                labelGo.transform.SetParent(buttonGo.transform, false);
                Text label = labelGo.AddComponent<Text>();
                label.text = "YouTube";
                label.font = BuiltinUiFont();
                label.fontSize = 20;
                label.alignment = TextAnchor.MiddleCenter;
                label.color = Color.white;
                label.raycastTarget = false;
                RectTransform labelRect = labelGo.GetComponent<RectTransform>();
                labelRect.anchorMin = Vector2.zero;
                labelRect.anchorMax = Vector2.one;
                labelRect.offsetMin = Vector2.zero;
                labelRect.offsetMax = Vector2.zero;

                UnityEngine.Events.UnityAction action =
                    Il2CppInterop.Runtime.DelegateSupport.ConvertDelegate<UnityEngine.Events.UnityAction>(new Action(OpenYoutube));
                button.onClick.AddListener(action);

                youtubeButtonRoot = canvasGo;
                Trace.LogInfo("youtube : bouton ajoute en bas a droite (ouvre " + YoutubeUrl + " dans le navigateur).");
            }
            catch (Exception error)
            {
                Trace.LogWarning("youtube : bouton impossible (" + error.Message + ")");
            }
        }

        private static Font BuiltinUiFont()
        {
            Font font = null;
            try { font = Resources.GetBuiltinResource<Font>("Arial.ttf"); } catch { }
            if (font == null)
            {
                try { font = Font.CreateDynamicFontFromOSFont("Arial", 20); } catch { }
            }
            return font;
        }

        private static void OpenYoutube()
        {
            try
            {
                Trace.LogInfo("youtube : ouverture de " + YoutubeUrl);
                Application.OpenURL(YoutubeUrl);
            }
            catch (Exception error)
            {
                Trace.LogWarning("youtube : ouverture impossible (" + error.Message + ")");
            }
        }

        public override void Load()
        {
            Trace = Log;
            Trace.LogInfo("titre : mode titre seul (login et ecrans de chargement).");
            if (EnableLogoBranding) InstallLogoGuards(Log);
            if (EnablePanelTinting || EnableBoardTint) InstallPanelHooks(Log);
            Log.LogInfo("REC BLUE 3.0.0 : plugin charge (titre seul, aucun autre reglage).");
            // Le jeu desactive l'objet du plugin apres le chargement initial. Les gardes
            // Harmony le reactivent quand une nouvelle interface (Dorm Room, login) arrive.
            BrandingScan scan = AddComponent<BrandingScan>();
            // Sonde fps opt-in : elle ecrit dans le journal toutes les 5 s et peut
            // provoquer des a-coups sur le thread principal. Desactivee par defaut.
            if (System.IO.File.Exists("C:/RecRoom2023/BepInEx/plugins/RECBLUE_PROBE.txt"))
                AddComponent<FpsProbe>();
            BrandingScan.Active = scan;
            try
            {
                Camera.onPreRender += Il2CppInterop.Runtime.DelegateSupport.ConvertDelegate<Camera.CameraCallback>(new Action<Camera>(OnCameraPreRender));
            }
            catch (Exception e)
            {
                Log.LogWarning("titre : camera tick indisponible (" + e.Message + ")");
            }
            // Le timer et les hooks de titre ne servent que si le branding est actif.
            if (EnableLogoBranding)
            {
                TryStartTitleTimer();
                InstallTitleTick(Log);
            }
            // Le composant de scene disparait apres le boot : ce hook Canvas reste
            // actif et ne fait que la passe legere du titre login/loading.
            if (EnableLoadingTitle) InstallLoadingTitleTick(Log);
            // L'ecran de bannissement ecrit lui-meme « contact us at recroom.zendesk.com » :
            // le serveur n'a aucun moyen de changer ce texte, on le reecrit a l'instant ou
            // le libelle est pose.
            BrandingScan.InstallSupportLinkRewrite(Log);
            Log.LogInfo("pilote : composant de branding charge.");
        }

        // Demarre depuis Update : SynchronizationContext.Current y est celui d'Unity,
        // contrairement a Load. Le timer poste la passe sur le thread principal.
        internal static void TryStartTitleTimer()
        {
            if (titleTimer != null) return;
            SynchronizationContext context = SynchronizationContext.Current;
            if (context == null) return;
            titleContext = context;
            titleTimer = new System.Threading.Timer(_ =>
            {
                SynchronizationContext ctx = titleContext;
                if (ctx == null) return;
                ctx.Post(__ =>
                {
                    try
                    {
                        BrandingScan.EnsureDriverActive();
                        BrandingScan.ApplyTitleStatic();
                    }
                    catch { }
                    if (BrandingScan.TitleDone && titleTimer != null)
                    {
                        try { titleTimer.Dispose(); } catch { }
                    }
                }, null);
            }, null, 5000, 1000);
            Trace.LogInfo("titre : pilote planifie sur le thread principal (5 s).");
        }

        // Canvas.SendWillRenderCanvases est appele a chaque rendu, meme quand le
        // GameObject du plugin a ete desactive par un changement de scene. C'est le
        // seul chemin fiable pour la passe de titre apres le chargement initial.
        private static void InstallTitleTick(BepInEx.Logging.ManualLogSource log)
        {
            try
            {
                MethodInfo method = HarmonyLib.AccessTools.Method(typeof(Canvas), "SendWillRenderCanvases");
                if (method == null)
                {
                    log.LogWarning("titre : Canvas.SendWillRenderCanvases introuvable (pilote global indisponible).");
                    return;
                }
                HarmonyLib.Harmony harmony = new HarmonyLib.Harmony("rec.blue.title.tick");
                MethodInfo postfix = typeof(BrandingPlugin).GetMethod("TitleTickPostfix", BindingFlags.Static | BindingFlags.NonPublic);
                harmony.Patch(method, postfix: new HarmonyLib.HarmonyMethod(postfix));
                MethodInfo render = HarmonyLib.AccessTools.Method(typeof(Camera), "Render");
                if (render != null)
                {
                    MethodInfo cameraPostfix = typeof(BrandingPlugin).GetMethod("CameraRenderPostfix", BindingFlags.Static | BindingFlags.NonPublic);
                    harmony.Patch(render, postfix: new HarmonyLib.HarmonyMethod(cameraPostfix));
                }
                MethodInfo eventUpdate = HarmonyLib.AccessTools.Method(typeof(UnityEngine.EventSystems.EventSystem), "Update");
                if (eventUpdate != null)
                {
                    MethodInfo eventPostfix = typeof(BrandingPlugin).GetMethod("EventSystemPostfix", BindingFlags.Static | BindingFlags.NonPublic);
                    harmony.Patch(eventUpdate, postfix: new HarmonyLib.HarmonyMethod(eventPostfix));
                }
                MethodInfo scaler = HarmonyLib.AccessTools.Method(typeof(CanvasScaler), "Update");
                if (scaler != null)
                {
                    MethodInfo scalerPostfix = typeof(BrandingPlugin).GetMethod("CanvasScalerPostfix", BindingFlags.Static | BindingFlags.NonPublic);
                    harmony.Patch(scaler, postfix: new HarmonyLib.HarmonyMethod(scalerPostfix));
                }
                MethodInfo input = HarmonyLib.AccessTools.Method(typeof(UnityEngine.EventSystems.StandaloneInputModule), "Process");
                if (input != null)
                {
                    MethodInfo inputPostfix = typeof(BrandingPlugin).GetMethod("InputModulePostfix", BindingFlags.Static | BindingFlags.NonPublic);
                    harmony.Patch(input, postfix: new HarmonyLib.HarmonyMethod(inputPostfix));
                }
                MethodInfo color = HarmonyLib.AccessTools.Method(typeof(Graphic), "set_color");
                if (color != null)
                {
                    MethodInfo tick = typeof(BrandingPlugin).GetMethod("TitleTickPostfix", BindingFlags.Static | BindingFlags.NonPublic);
                    harmony.Patch(color, postfix: new HarmonyLib.HarmonyMethod(tick));
                }
                MethodInfo canvasUpdate = HarmonyLib.AccessTools.Method(typeof(CanvasUpdateRegistry), "PerformUpdate");
                if (canvasUpdate != null)
                {
                    MethodInfo tick = typeof(BrandingPlugin).GetMethod("TitleTickPostfix", BindingFlags.Static | BindingFlags.NonPublic);
                    harmony.Patch(canvasUpdate, postfix: new HarmonyLib.HarmonyMethod(tick));
                }
                MethodInfo setActive = HarmonyLib.AccessTools.Method(typeof(GameObject), "SetActive");
                if (setActive != null)
                {
                    MethodInfo tick = typeof(BrandingPlugin).GetMethod("TitleTickPostfix", BindingFlags.Static | BindingFlags.NonPublic);
                    harmony.Patch(setActive, postfix: new HarmonyLib.HarmonyMethod(tick));
                }
                MethodInfo alpha = HarmonyLib.AccessTools.Method(typeof(CanvasGroup), "set_alpha");
                if (alpha != null)
                {
                    MethodInfo tick = typeof(BrandingPlugin).GetMethod("TitleTickPostfix", BindingFlags.Static | BindingFlags.NonPublic);
                    harmony.Patch(alpha, postfix: new HarmonyLib.HarmonyMethod(tick));
                }
                MethodInfo scale = HarmonyLib.AccessTools.Method(typeof(Transform), "set_localScale");
                if (scale != null)
                {
                    MethodInfo tick = typeof(BrandingPlugin).GetMethod("TitleTickPostfix", BindingFlags.Static | BindingFlags.NonPublic);
                    harmony.Patch(scale, postfix: new HarmonyLib.HarmonyMethod(tick));
                }
                MethodInfo frameCount = HarmonyLib.AccessTools.Method(typeof(Time), "get_frameCount");
                if (frameCount != null)
                {
                    MethodInfo tick = typeof(BrandingPlugin).GetMethod("TitleTickPostfix", BindingFlags.Static | BindingFlags.NonPublic);
                    harmony.Patch(frameCount, postfix: new HarmonyLib.HarmonyMethod(tick));
                }
                MethodInfo time = HarmonyLib.AccessTools.Method(typeof(Time), "get_time");
                if (time != null)
                {
                    MethodInfo tick = typeof(BrandingPlugin).GetMethod("TitleTickPostfix", BindingFlags.Static | BindingFlags.NonPublic);
                    harmony.Patch(time, postfix: new HarmonyLib.HarmonyMethod(tick));
                }
                MethodInfo delta = HarmonyLib.AccessTools.Method(typeof(Time), "get_deltaTime");
                if (delta != null)
                {
                    MethodInfo tick = typeof(BrandingPlugin).GetMethod("TitleTickPostfix", BindingFlags.Static | BindingFlags.NonPublic);
                    harmony.Patch(delta, postfix: new HarmonyLib.HarmonyMethod(tick));
                }
                MethodInfo uiText = HarmonyLib.AccessTools.Method(typeof(UnityEngine.UI.Text), "set_text");
                if (uiText != null)
                {
                    MethodInfo tick = typeof(BrandingPlugin).GetMethod("TitleTickPostfix", BindingFlags.Static | BindingFlags.NonPublic);
                    harmony.Patch(uiText, postfix: new HarmonyLib.HarmonyMethod(tick));
                }
                MethodInfo rawTexture = HarmonyLib.AccessTools.Method(typeof(RawImage), "set_texture");
                if (rawTexture != null)
                {
                    MethodInfo tick = typeof(BrandingScan).GetMethod("RawImageTexturePostfix", BindingFlags.Static | BindingFlags.NonPublic);
                    harmony.Patch(rawTexture, postfix: new HarmonyLib.HarmonyMethod(tick));
                }
            }
            catch (Exception e)
            {
                log.LogWarning("titre : pilote global indisponible (" + e.Message + ")");
            }
        }

        private static void InstallLoadingTitleTick(BepInEx.Logging.ManualLogSource log)
        {
            try
            {
                HarmonyLib.Harmony harmony = new HarmonyLib.Harmony("rec.blue.loading.title");
                MethodInfo postfix = typeof(BrandingPlugin).GetMethod("LoadingTitleTickPostfix", BindingFlags.Static | BindingFlags.NonPublic);
                HarmonyLib.HarmonyMethod patch = new HarmonyLib.HarmonyMethod(postfix);
                int installed = 0;
                MethodInfo canvas = HarmonyLib.AccessTools.Method(typeof(Canvas), "SendWillRenderCanvases");
                if (canvas != null) { harmony.Patch(canvas, postfix: patch); installed++; }
                MethodInfo render = HarmonyLib.AccessTools.Method(typeof(Camera), "Render");
                if (render != null) { harmony.Patch(render, postfix: patch); installed++; }
                MethodInfo eventUpdate = HarmonyLib.AccessTools.Method(typeof(UnityEngine.EventSystems.EventSystem), "Update");
                if (eventUpdate != null) { harmony.Patch(eventUpdate, postfix: patch); installed++; }
                MethodInfo scaler = HarmonyLib.AccessTools.Method(typeof(CanvasScaler), "Update");
                if (scaler != null) { harmony.Patch(scaler, postfix: patch); installed++; }
                MethodInfo setActive = HarmonyLib.AccessTools.Method(typeof(GameObject), "SetActive");
                if (setActive != null) { harmony.Patch(setActive, postfix: patch); installed++; }
                log.LogInfo("titre loading : hooks Canvas/Camera/EventSystem/CanvasScaler/SetActive=" + installed + ".");
            }
            catch (Exception e)
            {
                log.LogWarning("titre loading : hooks indisponibles (" + e.Message + ")");
            }
        }

        private static void LoadingTitleTickPostfix()
        {
            if (!EnableLoadingTitle) return;
            BrandingScan.ApplyLoadingTitle(Time.realtimeSinceStartup);
        }

        private static void TitleTickPostfix()
        {
            BrandingScan.ApplyTitleStatic();
        }

        private static void CameraRenderPostfix()
        {
            BrandingScan.ApplyTitleStatic();
        }

        private static bool cameraTickLogged;

        private static void OnCameraPreRender(UnityEngine.Camera camera)
        {
            if (!cameraTickLogged)
            {
                cameraTickLogged = true;
                Trace.LogInfo("titre : camera tick actif.");
            }
            BrandingScan.ApplyTitleStatic();
        }


        private static void EventSystemPostfix()
        {
            BrandingScan.ApplyTitleStatic();
        }

        private static void CanvasScalerPostfix()
        {
            BrandingScan.ApplyTitleStatic();
        }

        private static void InputModulePostfix()
        {
            BrandingScan.ApplyTitleStatic();
        }

        // Le jeu reconstruit son logo (retour au login, changement de compte, reouverture
        // du panneau) : un simple balayage laissait le logo Rec Room visible entre deux
        // passes. On intercepte l'affectation du sprite et l'activation des Image, pour
        // que l'original ne soit jamais dessine, meme une seule image.
        private static void InstallLogoGuards(BepInEx.Logging.ManualLogSource log)
        {
            try
            {
                HarmonyLib.Harmony harmony = new HarmonyLib.Harmony("rec.blue.logo");
                System.Reflection.BindingFlags flags = System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic;
                System.Reflection.MethodInfo setter = HarmonyLib.AccessTools.Method(typeof(UnityEngine.UI.Image), "set_sprite");
                if (setter != null)
                {
                    harmony.Patch(setter, prefix: new HarmonyLib.HarmonyMethod(typeof(LogoSetSpritePatch).GetMethod("Prefix", flags)));
                    log.LogInfo("logo : garde set_sprite active (le sprite Rec Room n'est plus jamais affecte).");
                }
                else log.LogWarning("logo : set_sprite introuvable, balayage seul.");
                System.Reflection.MethodInfo onEnable = HarmonyLib.AccessTools.Method(typeof(UnityEngine.UI.Image), "OnEnable");
                if (onEnable != null)
                {
                    harmony.Patch(onEnable, postfix: new HarmonyLib.HarmonyMethod(typeof(LogoOnEnablePatch).GetMethod("Postfix", flags)));
                    log.LogInfo("logo : garde OnEnable active (logo corrige avant le premier rendu).");
                }
                else log.LogWarning("logo : OnEnable introuvable, balayage seul.");
            }
            catch (Exception error)
            {
                log.LogWarning("logo : garde non installee (" + error.Message + "), balayage seul.");
            }
        }

        // Teinte des grands panneaux (tableau de la Dorm Room) independante du branding
        // du logo : on ecoute l'activation des Image et l'affectation des textures.
        private static void InstallPanelHooks(BepInEx.Logging.ManualLogSource log)
        {
            try
            {
                HarmonyLib.Harmony harmony = new HarmonyLib.Harmony("rec.blue.panels");
                System.Reflection.BindingFlags flags = System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic;
                System.Reflection.MethodInfo onEnable = HarmonyLib.AccessTools.Method(typeof(UnityEngine.UI.Image), "OnEnable");
                if (onEnable != null)
                {
                    harmony.Patch(onEnable, postfix: new HarmonyLib.HarmonyMethod(typeof(PanelImageOnEnablePatch).GetMethod("Postfix", flags)));
                    log.LogInfo("panneaux : hook Image.OnEnable actif.");
                }
                System.Reflection.MethodInfo rawEnable = HarmonyLib.AccessTools.Method(typeof(UnityEngine.UI.RawImage), "OnEnable");
                if (rawEnable != null)
                {
                    harmony.Patch(rawEnable, postfix: new HarmonyLib.HarmonyMethod(typeof(PanelRawImageOnEnablePatch).GetMethod("Postfix", flags)));
                    log.LogInfo("panneaux : hook RawImage.OnEnable actif.");
                }
                System.Reflection.MethodInfo rawSet = HarmonyLib.AccessTools.Method(typeof(UnityEngine.UI.RawImage), "set_texture");
                if (rawSet != null)
                {
                    System.Reflection.MethodInfo tick = typeof(BrandingScan).GetMethod("RawImageTexturePostfix", flags);
                    harmony.Patch(rawSet, postfix: new HarmonyLib.HarmonyMethod(tick));
                    log.LogInfo("panneaux : hook RawImage.set_texture actif.");
                }
            }
            catch (Exception error)
            {
                log.LogWarning("panneaux : hooks non installes (" + error.Message + ").");
            }
        }
    }

    // Affectation d'un sprite de marque : on la remplace avant que l'Image ne la garde.
    internal static class LogoSetSpritePatch
    {
        private static void Prefix(UnityEngine.UI.Image __instance, ref UnityEngine.Sprite value)
        {
            BrandingScan.GuardSprite(__instance, ref value);
        }
    }

    // Image activee (prefab instancie, panneau reaffiche) : le sprite d'origine peut venir
    // des donnees serialisees sans passer par set_sprite, on le corrige avant le rendu.
    internal static class LogoOnEnablePatch
    {
        private static void Postfix(UnityEngine.UI.Image __instance)
        {
            BrandingScan.GuardExisting(__instance);
        }
    }

    // Texture d'un RawImage : les visuels de campagne des ecrans de chargement
    // (setup_..._2560x1440) sont remplaces par les images REC BLUE.
    internal static class LoadingTexturePatch
    {
        private static void Prefix(UnityEngine.UI.RawImage __instance, ref UnityEngine.Texture value)
        {
            BrandingScan.GuardTexture(__instance, ref value);
        }
    }

    // Image activee : demande la teinte des grands panneaux (tableau de la Dorm Room).
    internal static class PanelImageOnEnablePatch
    {
        private static void Postfix(UnityEngine.UI.Image __instance)
        {
            BrandingScan.TintBackgroundsForGraphic(__instance);
        }
    }

    internal static class PanelRawImageOnEnablePatch
    {
        private static void Postfix(UnityEngine.UI.RawImage __instance)
        {
            BrandingScan.TintBackgroundsForGraphic(__instance);
        }
    }

    // ---------------------------------------------------------------- chargement
    // Les visuels affiches apres le login sont lus dans un dossier du joueur :
    // BepInEx/plugins/RecBlueLoading. Aucune recompilation pour en changer.
    internal static class LoadingArt
    {
        private const string Folder = "C:/RecRoom2023/BepInEx/plugins/RecBlueLoading";
        // Remplacement des visuels desactive : le jeu affiche ses propres images de
        // chargement, comme avant le plugin. Repasser a true pour reactiver.
        internal const bool Enabled = false;
        private static Sprite[] sprites = new Sprite[0];
        private static Texture2D[] textures = new Texture2D[0];
        private static int index;
        private static float nextRead;
        private static bool loaded;
        private static Sprite current;
        private static int lastTarget;
        private static Sprite fallbackSprite;
        private static Texture2D fallbackTexture;

        internal static bool IsLoadingTexture(string name)
        {
            if (!LoadingArt.Enabled) return false;
            if (string.IsNullOrEmpty(name)) return false;
            if (name.IndexOf("LoadingScreen_Tex", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (name.IndexOf("CustomLoadingScreen", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (name.IndexOf("2560x1440", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (name.EndsWith("tip.jpg", StringComparison.OrdinalIgnoreCase)) return true;
            return name.StartsWith("setup_", StringComparison.OrdinalIgnoreCase);
        }

        internal static void Ensure()
        {
            if (loaded) return;
            float now = Time.realtimeSinceStartup;
            if (now < nextRead) return;
            nextRead = now + 3f;
            try
            {
                if (!Directory.Exists(Folder)) { Directory.CreateDirectory(Folder); return; }
                List<string> files = new List<string>();
                foreach (string file in Directory.GetFiles(Folder))
                {
                    string ext = Path.GetExtension(file).ToLowerInvariant();
                    if (ext == ".png" || ext == ".jpg" || ext == ".jpeg") files.Add(file);
                }
                if (files.Count == 0) return;
                files.Sort(StringComparer.OrdinalIgnoreCase);
                List<Sprite> madeSprites = new List<Sprite>();
                List<Texture2D> madeTextures = new List<Texture2D>();
                foreach (string file in files)
                {
                    try
                    {
                        byte[] bytes = File.ReadAllBytes(file);
                        Texture2D texture = new Texture2D(2, 2, TextureFormat.RGBA32, false);
                        if (!ImageConversion.LoadImage(texture, bytes)) continue;
                        texture.hideFlags = HideFlags.DontUnloadUnusedAsset;
                        texture.name = "RecBlueLoading_" + madeTextures.Count;
                        Sprite sprite = Sprite.Create(texture, new Rect(0f, 0f, texture.width, texture.height), new Vector2(0.5f, 0.5f), 100f);
                        sprite.name = "RecBlueLoading";
                        madeTextures.Add(texture);
                        madeSprites.Add(sprite);
                    }
                    catch { }
                }
                if (madeSprites.Count == 0) return;
                sprites = madeSprites.ToArray();
                textures = madeTextures.ToArray();
                loaded = true;
                BrandingPlugin.Trace.LogInfo("chargement : " + sprites.Length + " image(s) REC BLUE chargee(s) depuis " + Folder);
            }
            catch (Exception error)
            {
                BrandingPlugin.Trace.LogWarning("chargement : dossier illisible (" + error.Message + ").");
            }
        }

        // Dossier vide : le client garde son visuel REC BLUE embarque, jamais la photo
        // de campagne Rec Room.
        private static void EnsureFallback()
        {
            if (fallbackTexture != null) return;
            try
            {
                using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("RecBlueLoadingDefault.png"))
                {
                    if (stream == null) return;
                    byte[] bytes = new byte[stream.Length];
                    stream.Read(bytes, 0, bytes.Length);
                    Texture2D texture = new Texture2D(2, 2, TextureFormat.RGBA32, false);
                    if (!ImageConversion.LoadImage(texture, bytes)) return;
                    texture.hideFlags = HideFlags.DontUnloadUnusedAsset;
                    texture.name = "RecBlueLoading_Default";
                    Sprite sprite = Sprite.Create(texture, new Rect(0f, 0f, texture.width, texture.height), new Vector2(0.5f, 0.5f), 100f);
                    sprite.name = "RecBlueLoading";
                    fallbackTexture = texture;
                    fallbackSprite = sprite;
                    BrandingPlugin.Trace.LogInfo("chargement : visuel REC BLUE par defaut (dossier vide).");
                }
            }
            catch (Exception error)
            {
                BrandingPlugin.Trace.LogWarning("chargement : visuel par defaut indisponible (" + error.Message + ").");
            }
        }

        // Une image par ecran de chargement : l'objet change a chaque chargement, donc son
        // identifiant sert de compteur. Un nouvel ecran prend l'image suivante, comme la
        // rotation des visuels du jeu d'origine.
        internal static Sprite PickFor(int target)
        {
            Ensure();
            if (sprites.Length == 0) { EnsureFallback(); return fallbackSprite; }
            if (current == null || target != lastTarget)
            {
                current = sprites[index % sprites.Length];
                index = (index + 1) % sprites.Length;
                lastTarget = target;
            }
            return current;
        }

        // Appele quand l'ecran de chargement disparait : le prochain ecran repart sur
        // l'image suivante, que le jeu recree l'objet ou reutilise le meme.
        internal static void ResetCycle()
        {
            lastTarget = 0;
            current = null;
        }

        internal static Texture2D TextureFor(int target)
        {
            Ensure();
            if (sprites.Length == 0) { EnsureFallback(); return fallbackTexture; }
            PickFor(target);
            if (current == null) return null;
            int position = Array.IndexOf(sprites, current);
            return position >= 0 ? textures[position] : null;
        }
    }

    // Mesure de FPS isolee : quelques lignes de journal, puis l'objet se detruit.
    public class FpsProbe : MonoBehaviour
    {
        private const string LongProbeMarker = "C:/RecRoom2023/BepInEx/plugins/RECBLUE_FPS_LONG.txt";
        public FpsProbe(IntPtr ptr) : base(ptr) { }

        private int frames;
        private int samples;
        private float last;
        private float worst;
        private int slow;

        private void Update()
        {
            // La moyenne peut etre bonne alors que le jeu saccade sur un pic isole :
            // c'est ce pic qui se ressent, donc on le mesure.
            float dt = Time.unscaledDeltaTime;
            if (dt > worst) worst = dt;
            if (dt > 0.0167f) slow++;

            float now = Time.realtimeSinceStartup;
            if (last <= 0f)
            {
                last = now;
                frames = Time.frameCount;
                return;
            }
            if (now - last < 5f) return;
            int delta = Time.frameCount - frames;
            float seconds = now - last;
            samples++;
            BrandingPlugin.Trace.LogInfo("fpsprobe : " + Mathf.RoundToInt(delta / Mathf.Max(0.001f, seconds)) + " fps | pire frame " + Mathf.RoundToInt(worst * 1000f) + " ms | frames lentes " + slow + " (echantillon " + samples + ")");
            last = now;
            frames = Time.frameCount;
            worst = 0f;
            slow = 0;
            if (samples >= 24)
            {
                bool longRun = false;
                try { longRun = File.Exists(LongProbeMarker); } catch { }
                if (!longRun || samples >= 240) Destroy(this);
            }
        }
    }

    // ---------------------------------------------------------------- console
    // Le client 2023 interroge des services morts (localisation, analytics, 404).
    // Ces lignes noient la console : on les jette avant qu'elles n'atteignent les
    // listeners, et on laisse passer tout le reste.
    // ---------------------------------------------------------------- qualite
    // Le plugin ne doit jamais degrader le rendu. On photographie les reglages
    // visuels au chargement, puis on les remet en place des qu'un seul bouge.
    // Les reglages de cadence (vsync, plafond fps, maxQueuedFrames) ne sont pas
    // concernes : ce ne sont pas des reglages visuels.
    // Pour laisser le jeu libre de changer (menu options), il suffit de creer
    // RECBLUE_QUALITE_LIBRE.txt : le garde-fou se met alors en veille.
    public static class QualityGuard
    {
        private const string FreeMarker = "C:\\RecRoom2023\\BepInEx\\plugins\\RECBLUE_QUALITE_LIBRE.txt";

        private static bool captured;
        private static bool freeMode;
        private static bool freeChecked;
        private static bool resolutionReported;
        private static float nextCheck;
        private static int restored;

        private static UnityEngine.ShadowQuality shadows;
        private static UnityEngine.ShadowResolution shadowResolution;
        private static UnityEngine.ShadowProjection shadowProjection;
        private static float shadowDistance;
        private static int antiAliasing;
        private static int textureLimit;
        private static UnityEngine.AnisotropicFiltering anisotropy;
        private static float lodBias;
        private static int pixelLights;
        private static bool softParticles;
        private static bool reflectionProbes;
        private static int screenWidth;
        private static int screenHeight;

        internal static void Capture(BepInEx.Logging.ManualLogSource log)
        {
            if (captured) return;
            captured = true;
            try
            {
                shadows = UnityEngine.QualitySettings.shadows;
                shadowResolution = UnityEngine.QualitySettings.shadowResolution;
                shadowProjection = UnityEngine.QualitySettings.shadowProjection;
                shadowDistance = UnityEngine.QualitySettings.shadowDistance;
                antiAliasing = UnityEngine.QualitySettings.antiAliasing;
                textureLimit = UnityEngine.QualitySettings.masterTextureLimit;
                anisotropy = UnityEngine.QualitySettings.anisotropicFiltering;
                lodBias = UnityEngine.QualitySettings.lodBias;
                pixelLights = UnityEngine.QualitySettings.pixelLightCount;
                softParticles = UnityEngine.QualitySettings.softParticles;
                reflectionProbes = UnityEngine.QualitySettings.realtimeReflectionProbes;
                screenWidth = UnityEngine.Screen.width;
                screenHeight = UnityEngine.Screen.height;
                log.LogInfo("qualite : verrouillee (ombres=" + shadows + ", AA=" + antiAliasing + ", mip=" + textureLimit + ", LOD=" + lodBias.ToString("0.0") + ", lumieres=" + pixelLights + ", " + screenWidth + "x" + screenHeight + ")");
            }
            catch (Exception error)
            {
                log.LogWarning("qualite : photographie impossible (" + error.Message + ").");
            }
        }

        internal static void Enforce(BepInEx.Logging.ManualLogSource log, float now)
        {
            if (!captured) return;
            if (now < nextCheck) return;
            nextCheck = now + 2f;
            try
            {
                if (!freeChecked)
                {
                    freeChecked = true;
                    try { freeMode = System.IO.File.Exists(FreeMarker); } catch { }
                    if (freeMode) log.LogInfo("qualite : garde-fou en veille (RECBLUE_QUALITE_LIBRE.txt present).");
                }
                if (!resolutionReported && (UnityEngine.Screen.width != screenWidth || UnityEngine.Screen.height != screenHeight))
                {
                    resolutionReported = true;
                    log.LogWarning("qualite : resolution changee par le jeu (" + UnityEngine.Screen.width + "x" + UnityEngine.Screen.height + "), laissee telle quelle.");
                }
                if (freeMode) return;
                if (UnityEngine.QualitySettings.shadows != shadows)
                {
                    UnityEngine.QualitySettings.shadows = shadows;
                    Restore(log, "ombres");
                }
                if (UnityEngine.QualitySettings.shadowResolution != shadowResolution)
                {
                    UnityEngine.QualitySettings.shadowResolution = shadowResolution;
                    Restore(log, "precision des ombres");
                }
                if (UnityEngine.QualitySettings.shadowProjection != shadowProjection)
                {
                    UnityEngine.QualitySettings.shadowProjection = shadowProjection;
                    Restore(log, "projection des ombres");
                }
                if (Mathf.Abs(UnityEngine.QualitySettings.shadowDistance - shadowDistance) > 0.01f)
                {
                    UnityEngine.QualitySettings.shadowDistance = shadowDistance;
                    Restore(log, "distance des ombres");
                }
                if (UnityEngine.QualitySettings.antiAliasing != antiAliasing)
                {
                    UnityEngine.QualitySettings.antiAliasing = antiAliasing;
                    Restore(log, "anti-aliasing");
                }
                if (UnityEngine.QualitySettings.masterTextureLimit != textureLimit)
                {
                    UnityEngine.QualitySettings.masterTextureLimit = textureLimit;
                    Restore(log, "taille des textures");
                }
                if (UnityEngine.QualitySettings.anisotropicFiltering != anisotropy)
                {
                    UnityEngine.QualitySettings.anisotropicFiltering = anisotropy;
                    Restore(log, "filtrage anisotrope");
                }
                if (Mathf.Abs(UnityEngine.QualitySettings.lodBias - lodBias) > 0.001f)
                {
                    UnityEngine.QualitySettings.lodBias = lodBias;
                    Restore(log, "niveau de detail");
                }
                if (UnityEngine.QualitySettings.pixelLightCount != pixelLights)
                {
                    UnityEngine.QualitySettings.pixelLightCount = pixelLights;
                    Restore(log, "lumieres par pixel");
                }
                if (UnityEngine.QualitySettings.softParticles != softParticles)
                {
                    UnityEngine.QualitySettings.softParticles = softParticles;
                    Restore(log, "particules douces");
                }
                if (UnityEngine.QualitySettings.realtimeReflectionProbes != reflectionProbes)
                {
                    UnityEngine.QualitySettings.realtimeReflectionProbes = reflectionProbes;
                    Restore(log, "reflets temps reel");
                }
            }
            catch { }
        }

        private static void Restore(BepInEx.Logging.ManualLogSource log, string name)
        {
            restored++;
            log.LogWarning("qualite : " + name + " remis au reglage d'origine (" + restored + ").");
        }
    }

    public static class QuietConsole
    {
        private static readonly string[] Noise =
        {
            "HTTP Error",
            "Failed to retrieve strings",
            "trying to download strings",
            "Response was empty",
            "Gamesight",
            "Unknown Material guid",
            "doesn't have a texture property '_MainTex'",
            "Could not find an entry with key",
            "Processing queued table",
            "Received blank response when we expected data",
            "does not have an associated browsable avatar item filter",
            "Duplicate property: max_players_in_room",
            "for NonPurchasedNotUsableInP2P",
            "Collection was modified; enumeration operation may not execute",
            "Could not initialize OpenVR",
            "Unable to start VR Subsystem",
            "Missing VolumeProfile on VignetteImageEffect",
            "Missing Active Controller",
            "The referenced script (RecRoom.Debugging.DebugCommandListOnFirstLoginInvoker)",
            "Game Object '[DebugConsole]'",
            "StatSig is disabled",
            // Le dortoir "hors session" ecrit au kick produit encore une presence que le
            // client declare out-of-sync (mesure : erreurs uniquement pendant ce sejour au
            // dortoir, disparition des l'entree dans une vraie chambre a 15:01:56). La
            // cause exacte reste ouverte ; en attendant, la ligne ne remplit plus la console.
            "local presence is out-of-sync"
        };

        // Ces messages viennent du client et du serveur prives, pas des plugins :
        // reponses HTTP vides, articles sans filtre, doublons d'evenements analytics.
        // On les coupe a la source pour qu'ils ne remplissent plus la console du jeu.
        private static readonly string[] UnityNoise =
        {
            "HTTP Error",
            "Failed to retrieve strings",
            "trying to download strings",
            "Response was empty",
            "Gamesight",
            "Unknown Material guid",
            "doesn't have a texture property '_MainTex'",
            "Could not find an entry with key",
            "Processing queued table",
            "Received blank response when we expected data",
            "does not have an associated browsable avatar item filter",
            "Duplicate property: max_players_in_room",
            "for NonPurchasedNotUsableInP2P",
            "Collection was modified; enumeration operation may not execute",
            "Could not initialize OpenVR",
            "Unable to start VR Subsystem",
            "Missing VolumeProfile on VignetteImageEffect",
            "Missing Active Controller",
            "The referenced script (RecRoom.Debugging.DebugCommandListOnFirstLoginInvoker)",
            "Game Object '[DebugConsole]'",
            "StatSig is disabled",
            // Le dortoir "hors session" ecrit au kick produit encore une presence que le
            // client declare out-of-sync (mesure : erreurs uniquement pendant ce sejour au
            // dortoir, disparition des l'entree dans une vraie chambre a 15:01:56). La
            // cause exacte reste ouverte ; en attendant, la ligne ne remplit plus la console.
            "local presence is out-of-sync"
        };

        private static int hidden;
        private static int unityHidden;
        private static bool installed;
        private static BepInEx.Logging.ManualLogSource summaryLog;
        private static readonly Dictionary<string, int> serializationSeen = new Dictionary<string, int>(StringComparer.Ordinal);
        private static readonly object serializationGate = new object();
        private static int serializationHidden;
        private static long nextSerializationSummaryAt;
        private static string lastSerializationText;

        public static int Hidden { get { return hidden; } }

        public static int UnityHidden { get { return unityHidden; } }

        internal static void Install(BepInEx.Logging.ManualLogSource log)
        {
            if (installed) return;
            installed = true;
            summaryLog = log;
            try
            {
                System.Reflection.MethodInfo target = null;
                System.Reflection.BindingFlags flags = System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic;
                foreach (System.Reflection.MethodInfo candidate in typeof(BepInEx.Logging.Logger).GetMethods(flags))
                {
                    if (candidate.Name != "InternalLogEvent") continue;
                    System.Reflection.ParameterInfo[] parameters = candidate.GetParameters();
                    if (parameters.Length == 2 && parameters[1].ParameterType == typeof(BepInEx.Logging.LogEventArgs))
                    {
                        target = candidate;
                        break;
                    }
                }
                if (target == null)
                {
                    log.LogWarning("console : filtre BepInEx indisponible, lignes du jeu laissees telles quelles.");
                }
                else
                {
                    HarmonyLib.Harmony harmony = new HarmonyLib.Harmony("rec.blue.quietconsole");
                    harmony.Patch(target, prefix: new HarmonyLib.HarmonyMethod(typeof(QuietConsole).GetMethod("Prefix", flags)));
                    log.LogInfo("console : filtre reseau actif.");
                }
            }
            catch (Exception error)
            {
                log.LogWarning("console : filtre non installe (" + error.Message + ").");
            }
            int unity = InstallUnityFilter();
            log.LogInfo("console : filtre Unity actif (" + unity + " methode(s)).");
        }

        // La console du jeu et Player.log ne passent pas par BepInEx : il faut couper
        // les messages a la source, sur les methodes de journalisation d'Unity.
        private static int InstallUnityFilter()
        {
            int installed = 0;
            try
            {
                HarmonyLib.Harmony harmony = new HarmonyLib.Harmony("rec.blue.quietunity");
                Type message = typeof(Il2CppSystem.Object);
                Type exception = typeof(Il2CppSystem.Exception);
                Type context = typeof(UnityEngine.Object);
                Type[] messageOnly = { message };
                Type[] messageAndContext = { message, context };
                Type[] loggerMessage = { typeof(UnityEngine.LogType), message };
                Type[] loggerMessageAndContext = { typeof(UnityEngine.LogType), message, context };
                Type[] exceptionOnly = { exception };
                Type[] exceptionAndContext = { exception, context };
                Type formatArray = typeof(Il2CppReferenceArray<Il2CppSystem.Object>);
                Type[] formatOnly = { typeof(Il2CppSystem.String), formatArray };
                Type[] formatOnlySystem = { typeof(string), formatArray };
                Type[] loggerFormat = { typeof(UnityEngine.LogType), typeof(Il2CppSystem.String), formatArray };
                Type[] loggerFormatSystem = { typeof(UnityEngine.LogType), typeof(string), formatArray };

                installed += PatchUnity(harmony, typeof(UnityEngine.Debug), "Log", messageOnly, "FilterMessage");
                installed += PatchUnity(harmony, typeof(UnityEngine.Debug), "Log", messageAndContext, "FilterMessage");
                installed += PatchUnity(harmony, typeof(UnityEngine.Debug), "LogFormat", formatOnly, "FilterFormatMessage");
                installed += PatchUnity(harmony, typeof(UnityEngine.Debug), "LogFormat", formatOnlySystem, "FilterStringFormat");
                installed += PatchUnity(harmony, typeof(UnityEngine.Debug), "LogWarningFormat", formatOnly, "FilterFormatMessage");
                installed += PatchUnity(harmony, typeof(UnityEngine.Debug), "LogWarningFormat", formatOnlySystem, "FilterStringFormat");
                installed += PatchUnity(harmony, typeof(UnityEngine.Debug), "LogErrorFormat", formatOnly, "FilterFormatMessage");
                installed += PatchUnity(harmony, typeof(UnityEngine.Debug), "LogErrorFormat", formatOnlySystem, "FilterStringFormat");
                installed += PatchUnity(harmony, typeof(UnityEngine.Debug), "LogWarning", messageOnly, "FilterMessage");
                installed += PatchUnity(harmony, typeof(UnityEngine.Debug), "LogWarning", messageAndContext, "FilterMessage");
                installed += PatchUnity(harmony, typeof(UnityEngine.Debug), "LogError", messageOnly, "FilterMessage");
                installed += PatchUnity(harmony, typeof(UnityEngine.Debug), "LogError", messageAndContext, "FilterMessage");
                installed += PatchUnity(harmony, typeof(UnityEngine.Debug), "LogException", exceptionOnly, "FilterException");
                installed += PatchUnity(harmony, typeof(UnityEngine.Debug), "LogException", exceptionAndContext, "FilterException");
                installed += PatchUnity(harmony, typeof(UnityEngine.Logger), "Log", loggerMessage, "FilterLoggerMessage");
                installed += PatchUnity(harmony, typeof(UnityEngine.Logger), "Log", loggerMessageAndContext, "FilterLoggerMessage");
                installed += PatchUnity(harmony, typeof(UnityEngine.Logger), "LogFormat", loggerFormat, "FilterLoggerFormat");
                installed += PatchUnity(harmony, typeof(UnityEngine.Logger), "LogFormat", loggerFormatSystem, "FilterLoggerStringFormat");
                installed += PatchUnity(harmony, typeof(UnityEngine.Logger), "LogWarningFormat", formatOnly, "FilterFormatMessage");
                installed += PatchUnity(harmony, typeof(UnityEngine.Logger), "LogWarningFormat", formatOnlySystem, "FilterStringFormat");
                installed += PatchUnity(harmony, typeof(UnityEngine.Logger), "LogErrorFormat", formatOnly, "FilterFormatMessage");
                installed += PatchUnity(harmony, typeof(UnityEngine.Logger), "LogErrorFormat", formatOnlySystem, "FilterStringFormat");
                installed += PatchUnity(harmony, typeof(UnityEngine.Logger), "LogException", exceptionOnly, "FilterException");
                installed += PatchUnity(harmony, typeof(UnityEngine.Logger), "LogException", exceptionAndContext, "FilterException");
            }
            catch (Exception error)
            {
                if (summaryLog != null) summaryLog.LogWarning("console : filtre Unity indisponible (" + error.GetType().Name + " " + error.Message + ").");
            }
            return installed;
        }

        private static int PatchUnity(HarmonyLib.Harmony harmony, Type type, string name, Type[] signature, string prefixName)
        {
            try
            {
                MethodInfo method = type.GetMethod(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance, null, signature, null);
                if (method == null) return 0;
                MethodInfo prefix = typeof(QuietConsole).GetMethod(prefixName, BindingFlags.Static | BindingFlags.NonPublic);
                if (prefix == null) return 0;
                harmony.Patch(method, prefix: new HarmonyLib.HarmonyMethod(prefix));
                return 1;
            }
            catch { return 0; }
        }

        private static bool FilterMessage(Il2CppSystem.Object __0)
        {
            try { return !IsUnityNoise(__0 == null ? null : __0.ToString()); }
            catch { return true; }
        }

        private static bool FilterLoggerMessage(UnityEngine.LogType __0, Il2CppSystem.Object __1)
        {
            try { return !IsUnityNoise(__1 == null ? null : __1.ToString()); }
            catch { return true; }
        }

        private static bool FilterFormatMessage(Il2CppSystem.String __0)
        {
            try { return !IsUnityNoise(__0 == null ? null : __0.ToString()); }
            catch { return true; }
        }

        private static bool FilterStringFormat(string __0)
        {
            try { return !IsUnityNoise(__0); }
            catch { return true; }
        }

        private static bool FilterLoggerFormat(UnityEngine.LogType __0, Il2CppSystem.String __1)
        {
            try { return !IsUnityNoise(__1 == null ? null : __1.ToString()); }
            catch { return true; }
        }

        private static bool FilterLoggerStringFormat(UnityEngine.LogType __0, string __1)
        {
            try { return !IsUnityNoise(__1); }
            catch { return true; }
        }

        private static bool FilterException(Il2CppSystem.Exception __0)
        {
            try
            {
                if (__0 == null) return true;
                return !IsUnityNoise(__0.Message);
            }
            catch { return true; }
        }

        private static bool IsUnityNoise(string text)
        {
            if (string.IsNullOrEmpty(text)) return false;
            for (int i = 0; i < UnityNoise.Length; i++)
            {
                if (text.IndexOf(UnityNoise[i], StringComparison.OrdinalIgnoreCase) < 0) continue;
                System.Threading.Interlocked.Increment(ref unityHidden);
                return true;
            }
            return false;
        }

        // Les surcharges LogFormat/LogWarningFormat/LogErrorFormat sont celles utilisees
        // par le client pour les erreurs reseau et les avertissements de contenu.
        // Les erreurs de serialisation d'un meme objet reviennent des milliers de fois
        // par seconde dans WaterBottle_VendingMachine. On garde la premiere occurrence
        // de chaque message, on masque les repetitions, puis on publie un resume.
        private static bool SuppressSerialization(string text)
        {
            int hiddenNow = 0;
            string sample = null;
            lock (serializationGate)
            {
                string key = text;
                int count;
                if (!serializationSeen.TryGetValue(key, out count))
                {
                    // Borne memoire : au-dela, tous les messages inconnus partagent le
                    // meme compteur au lieu de faire grossir le dictionnaire sans fin.
                    if (serializationSeen.Count >= 128) key = "__overflow__";
                    if (!serializationSeen.TryGetValue(key, out count))
                    {
                        serializationSeen[key] = 1;
                        return false;
                    }
                }
                serializationSeen[key] = count + 1;
                serializationHidden++;
                lastSerializationText = text;
                long now = Environment.TickCount64;
                if (now >= nextSerializationSummaryAt)
                {
                    nextSerializationSummaryAt = now + 10000;
                    hiddenNow = serializationHidden;
                    serializationHidden = 0;
                    sample = lastSerializationText;
                }
            }
            if (hiddenNow > 0 && summaryLog != null)
            {
                if (sample != null && sample.Length > 180) sample = sample.Substring(0, 180) + "...";
                // Evite que le resume contienne lui-meme le motif filtre.
                if (sample != null) sample = sample.Replace("Error serializing", "Erreur serialisation");
                summaryLog.LogInfo("REC BLUE anti-spam : " + hiddenNow + " erreur(s) de serialisation repetee(s) masquee(s) ; premiere conservee. Derniere : " + sample);
            }
            return true;
        }

        private static bool Prefix(object __0, BepInEx.Logging.LogEventArgs __1)
        {
            try
            {
                if (__1 == null) return true;
                string text = __1.Data as string;
                if (string.IsNullOrEmpty(text)) return true;
                for (int i = 0; i < Noise.Length; i++)
                {
                    if (text.IndexOf(Noise[i], StringComparison.OrdinalIgnoreCase) < 0) continue;
                    System.Threading.Interlocked.Increment(ref hidden);
                    return false;
                }
                if (text.IndexOf("Error serializing", StringComparison.OrdinalIgnoreCase) >= 0)
                    return !SuppressSerialization(text);
            }
            catch { }
            return true;
        }
    }

    public class BrandingScan : MonoBehaviour
    {
        public BrandingScan(IntPtr ptr) : base(ptr) { }

        internal static BrandingScan Active;

        internal static void TickTitleGlobal()
        {
            BrandingScan scan = Active;
            if (scan != null) scan.TickTitle();
        }

        // Les gardes du logo tournent encore apres le changement de scene, meme si le
        // GameObject du plugin a ete desactive. On s'en sert pour relancer le pilote.
        internal static void EnsureDriverActive()
        {
            BrandingScan scan = Active;
            if (scan == null) return;
            try
            {
                bool changed = false;
                if (!scan.enabled) { scan.enabled = true; changed = true; }
                if (!scan.gameObject.activeSelf) { scan.gameObject.SetActive(true); changed = true; }
                if (changed) BrandingPlugin.Trace.LogInfo("titre : pilote reactive par le logo.");
            }
            catch { }
        }

        // Les grands panneaux (Dorm Room) sont construits apres le login : on demande
        // une seule teinte quand ils arrivent, au lieu d'attendre le prochain balayage.
        internal static void RequestLateTintFromGraphic(Graphic graphic)
        {
            BrandingScan scan = Active;
            if (scan == null || graphic == null) return;
            float now = Time.realtimeSinceStartup;
            if (now < 10f) return;
            Rect box = default(Rect);
            try { box = graphic.rectTransform.rect; } catch { return; }
            if (box.width < 300f || box.height < 120f) return;
            scan.RequestLateTint(now, graphic);
        }

        internal static void RequestLateTintFromImage(Image image)
        {
            RequestLateTintFromGraphic(image);
        }

        private void RequestLateTint(float now, Graphic graphic)
        {
            if (now < lateTintAllowedAt) return;
            lateTintAt = now + 0.35f;
            lateTintAllowedAt = now + 3f;
            if (lateTintLogged) return;
            lateTintLogged = true;
            string path = "";
            try { path = PathOf(graphic.transform, 6); } catch { }
            BrandingPlugin.Trace.LogInfo("panneau : teinte tardive demandee (" + path + ")");
        }

        // -------------------------------------------------------- boutons du tableau
        // Les boutons du tableau qui menent chez Rec Room (Instagram, envoi de contenu,
        // conditions, confidentialite, aide) sont repris SUR PLACE : la mise en page, la
        // taille et le style viennent du jeu, on ne remplace que le libelle qui nomme
        // Rec Room et la cible du clic, qui ouvre desormais le site REC BLUE. On remplace
        // les ecouteurs du bouton au lieu de masquer puis recreer un bouton : un bouton
        // recree a l'aveugle ne tomberait pas juste au-dessus de l'original.
        internal static readonly bool EnableBoardLinkButtons = true;
        // Image de la recompense du defi de la semaine : le client dessine l'objet a gagner
        // lui-meme (elle ne vient pas du serveur), donc on remplace le visuel de
        // `[RewardDisplay]` par le logo REC BLUE.
        internal static readonly bool EnableRewardLogo = true;
        private const string RecBlueSiteUrl = "https://recblue.net";
        // Libelle exact du jeu (compare en minuscules) -> libelle REC BLUE -> page ouverte.
        // TOUS les boutons du tableau sont ici : aucun ne doit plus partir sur le site de
        // Rec Room, chacun ouvre recblue.net.
        private static readonly string[,] BoardLinkTargets = new string[,]
        {
            { "recroom instagram", "REC BLUE Instagram", RecBlueSiteUrl },
            { "submit your stuff", "Propose ton contenu", RecBlueSiteUrl },
            { "terms of service", "CGU", RecBlueSiteUrl },
            { "privacy policy", "Vie privee", RecBlueSiteUrl },
            { "help", "Aide", RecBlueSiteUrl },
            { "more info", "Plus d'infos", RecBlueSiteUrl },
            { "view rooms", "Chambres du jeu", RecBlueSiteUrl },
            { "how to build", "Construire", RecBlueSiteUrl },
            { "player highlights", "Temps forts", RecBlueSiteUrl },
        };
        // Libelles renommes SANS toucher au clic : les titres des panneaux du tableau (ce ne
        // sont pas des boutons) et, si besoin, un bouton qui doit garder son action en jeu.
        private static readonly string[,] BoardLinkLabelOnly = new string[,]
        {
            { "#recroom on instagram", "#REC BLUE on Instagram" },
            { "#recroom on youtube", "#REC BLUE on YouTube" },
            // Panneau des defis de la semaine (region du tableau).
            { "weekly challenge reward", "Récompense REC BLUE" },
            { "weekly challenges", "Défis REC BLUE" },
            { "challenge theme goes here", "Thème du défi REC BLUE" },
        };
        private readonly List<int> relinkedButtons = new List<int>();
        private readonly List<string> missingLogged = new List<string>();
        private readonly List<string> renamedLabels = new List<string>();
        private bool boardLinkDumped;
        private static Texture2D rewardLogo;
        private static Sprite rewardLogoSprite;
        private static bool rewardLogoLoaded;
        private readonly List<string> rewardVisuals = new List<string>();
        private bool openUrlPatchTried;
        private float nextBoardLinkAt;
        private float nextBoardLinkLog;
        private int boardLinkTotal;
        // Cache du balayage du tableau : refait seulement quand la salle change.
        private readonly List<Text> boardLabels = new List<Text>();
        private readonly List<TextMesh> boardMeshes = new List<TextMesh>();
        private readonly List<TMP_Text> boardTmps = new List<TMP_Text>();
        private int boardRootId;
        private int boardWideScanRoot;

        /** Le libelle REC BLUE d'un bouton qu'on renomme seulement, ou null. */
        private static string LabelOnlyReplacement(string lower)
        {
            for (int i = 0; i < BoardLinkLabelOnly.GetLength(0); i++)
                if (lower == BoardLinkLabelOnly[i, 0]) return BoardLinkLabelOnly[i, 1];
            return null;
        }

        private void BoardLinkPass(float now)
        {
            if (!EnableBoardLinkButtons || safeMode) return;
            // Une seule fois : l'ouverture d'URL du jeu est detournee vers le site.
            if (!openUrlPatchTried)
            {
                openUrlPatchTried = true;
                InstallOpenUrlRedirect(BrandingPlugin.Trace);
            }
            if (now < nextBoardLinkAt) return;
            // 3 s pendant les 30 premieres secondes (le tableau se construit), puis toutes les
            // 60 s. Les versions precedentes balayaient la scene toutes les 2 s pendant une
            // minute entiere : c'est ce qui provoquait les a-coups au chargement.
            nextBoardLinkAt = now + (now < 30f ? 3f : 60f);
            float passStart = Time.realtimeSinceStartup;
            try
            {
                // Balayage limite aux deux panneaux concernes : un FindObjectsOfType sur toute
                // la scene coutait 13 a 26 ms par passe, soit un a-coup visible a chaque fois.
                Transform boardRoot = FindBoardRoot("CommunityBoard");
                Transform helpRoot = FindBoardRoot("HelpButtonsCanvas");
                // Le balayage n'est refait que si la salle change (les transform du tableau sont
                // alors de nouveaux objets). Le refaire a chaque passe allouait trois listes et,
                // au demarrage, trois FindObjectsOfType sur toute la scene : de quoi declencher
                // un ramasse-miettes et un gel de plus d'une seconde.
                int rootId = boardRoot != null ? boardRoot.GetInstanceID() : (helpRoot != null ? helpRoot.GetInstanceID() : 0);
                if (rootId != boardRootId || boardLabels.Count + boardMeshes.Count + boardTmps.Count == 0)
                {
                    boardRootId = rootId;
                    boardLabels.Clear();
                    boardMeshes.Clear();
                    boardTmps.Clear();
                    if (boardRoot != null || helpRoot != null)
                    {
                        CollectBoardLabels(boardRoot, boardLabels, boardMeshes, boardTmps);
                        CollectBoardLabels(helpRoot, boardLabels, boardMeshes, boardTmps);
                    }
                    if (boardLabels.Count + boardMeshes.Count + boardTmps.Count == 0 && boardWideScanRoot != rootId)
                    {
                        // Panneaux pas encore construits (ou nom inattendu) : un seul balayage
                        // large par salle, pas un toutes les 3 s.
                        boardWideScanRoot = rootId;
                        boardLabels.AddRange(UnityEngine.Object.FindObjectsOfType<Text>());
                        boardMeshes.AddRange(UnityEngine.Object.FindObjectsOfType<TextMesh>());
                        boardTmps.AddRange(UnityEngine.Object.FindObjectsOfType<TMP_Text>());
                    }
                }
                List<Text> labels = boardLabels;
                List<TextMesh> meshes = boardMeshes;
                List<TMP_Text> tmps = boardTmps;
                int found = labels.Count + meshes.Count + tmps.Count;
                if (found == 0)
                {
                    // Rien a faire tant que la room n'a pas de tableau : on repasse plus tard.
                    nextBoardLinkAt = now + 15f;
                    return;
                }
                int changed = 0;
                foreach (Text label in labels)
                {
                    if (label == null) continue;
                    string text;
                    try { text = label.text; } catch { continue; }
                    if (string.IsNullOrEmpty(text)) continue;
                    // Le libelle exact est le garde-fou : les boutons du mur vivent sur leur
                    // propre canvas, a cote du tableau, et n'ont pas d'ancetre CommunityBoard.
                    string lower = text.Trim().ToLowerInvariant();
                    // Renommage seul : le clic du jeu reste en place.
                    string renameOnly = LabelOnlyReplacement(lower);
                    if (renameOnly != null)
                    {
                        try { if (label.text != renameOnly) label.text = renameOnly; } catch { }
                        if (!renamedLabels.Contains(lower))
                        {
                            renamedLabels.Add(lower);
                            BrandingPlugin.Trace.LogInfo("tableau : libelle seul \"" + text + "\" -> \"" + renameOnly + "\" (clic du jeu conserve, " + PathOf(label.transform, 6) + ")");
                        }
                        continue;
                    }
                    string replacement = null;
                    string targetUrl = RecBlueSiteUrl;
                    for (int i = 0; i < BoardLinkTargets.GetLength(0); i++)
                    {
                        if (lower != BoardLinkTargets[i, 0]) continue;
                        replacement = BoardLinkTargets[i, 1];
                        targetUrl = BoardLinkTargets[i, 2];
                        break;
                    }
                    if (replacement == null) continue;
                    Button button = FindClickable(label.transform);
                    if (button == null)
                    {
                        string missing = PathOf(label.transform, 6);
                        if (!missingLogged.Contains(missing))
                        {
                            missingLogged.Add(missing);
                            BrandingPlugin.Trace.LogInfo("tableau : pas de bouton pour \"" + text + "\" (" + missing + ")");
                        }
                        continue;
                    }
                    int id = button.GetInstanceID();
                    if (!relinkedButtons.Contains(id))
                    {
                        relinkedButtons.Add(id);
                        try { button.onClick.RemoveAllListeners(); } catch { }
                        try
                        {
                            string url = targetUrl;
                            UnityEngine.Events.UnityAction action =
                                Il2CppInterop.Runtime.DelegateSupport.ConvertDelegate<UnityEngine.Events.UnityAction>(new Action(() => OpenUrl(url)));
                            button.onClick.AddListener(action);
                        }
                        catch (Exception error)
                        {
                            BrandingPlugin.Trace.LogWarning("tableau : clic non remplace (" + error.Message + ")");
                        }
                        boardLinkTotal++;
                        changed++;
                        BrandingPlugin.Trace.LogInfo("tableau : \"" + text + "\" -> \"" + replacement + "\" (" + PathOf(label.transform, 6) + ")");
                    }
                    // Le jeu peut reecrire son libelle : on le remet a chaque passe.
                    try { if (label.text != replacement) label.text = replacement; } catch { }
                }
                // Meme reprise pour les libelles en 3D.
                foreach (TextMesh mesh in meshes)
                {
                    if (mesh == null) continue;
                    string meshText;
                    try { meshText = mesh.text; } catch { continue; }
                    if (string.IsNullOrEmpty(meshText)) continue;
                    string meshLower = meshText.Trim().ToLowerInvariant();
                    string meshRename = LabelOnlyReplacement(meshLower);
                    if (meshRename != null)
                    {
                        try { if (mesh.text != meshRename) mesh.text = meshRename; } catch { }
                        if (!renamedLabels.Contains("mesh:" + meshLower))
                        {
                            renamedLabels.Add("mesh:" + meshLower);
                            BrandingPlugin.Trace.LogInfo("tableau : libelle seul \"" + meshText + "\" -> \"" + meshRename + "\" (clic du jeu conserve, " + PathOf(mesh.transform, 6) + ")");
                        }
                        continue;
                    }
                    string meshReplacement = null;
                    string meshUrl = RecBlueSiteUrl;
                    for (int i = 0; i < BoardLinkTargets.GetLength(0); i++)
                    {
                        if (meshLower != BoardLinkTargets[i, 0]) continue;
                        meshReplacement = BoardLinkTargets[i, 1];
                        meshUrl = BoardLinkTargets[i, 2];
                        break;
                    }
                    if (meshReplacement == null) continue;
                    Button meshButton = FindClickable(mesh.transform);
                    string meshPath = PathOf(mesh.transform, 6);
                    if (meshButton == null)
                    {
                        if (!missingLogged.Contains(meshPath))
                        {
                            missingLogged.Add(meshPath);
                            BrandingPlugin.Trace.LogInfo("tableau : pas de bouton pour \"" + meshText + "\" (" + meshPath + ")");
                        }
                        continue;
                    }
                    int meshId = meshButton.GetInstanceID();
                    if (!relinkedButtons.Contains(meshId))
                    {
                        relinkedButtons.Add(meshId);
                        try { meshButton.onClick.RemoveAllListeners(); } catch { }
                        try
                        {
                            string meshTarget = meshUrl;
                            UnityEngine.Events.UnityAction meshAction =
                                Il2CppInterop.Runtime.DelegateSupport.ConvertDelegate<UnityEngine.Events.UnityAction>(new Action(() => OpenUrl(meshTarget)));
                            meshButton.onClick.AddListener(meshAction);
                        }
                        catch (Exception error)
                        {
                            BrandingPlugin.Trace.LogWarning("tableau : clic non remplace (" + error.Message + ")");
                        }
                        boardLinkTotal++;
                        changed++;
                        BrandingPlugin.Trace.LogInfo("tableau : \"" + meshText + "\" -> \"" + meshReplacement + "\" (" + meshPath + ")");
                    }
                    try { if (mesh.text != meshReplacement) mesh.text = meshReplacement; } catch { }
                }
                // Le tableau ecrit ses libelles en TextMeshPro (les Text/TextMesh du jeu ne
                // portent que les titres de videos) : sans cette passe, rien n'est repris.
                if (tmps.Count > 0)
                {
                    foreach (TMP_Text tmp in tmps)
                    {
                        if (tmp == null) continue;
                        string tmpText;
                        try { tmpText = tmp.text; } catch { continue; }
                        if (string.IsNullOrEmpty(tmpText)) continue;
                        string tmpLower = tmpText.Trim().ToLowerInvariant();
                        string tmpRename = LabelOnlyReplacement(tmpLower);
                        if (tmpRename != null)
                        {
                            try { if (tmp.text != tmpRename) tmp.text = tmpRename; } catch { }
                            if (!renamedLabels.Contains("tmp-only:" + tmpLower))
                            {
                                renamedLabels.Add("tmp-only:" + tmpLower);
                                BrandingPlugin.Trace.LogInfo("tableau : libelle seul \"" + tmpText + "\" -> \"" + tmpRename + "\" (clic du jeu conserve, " + PathOf(tmp.transform, 6) + ")");
                            }
                            continue;
                        }
                        string tmpReplacement = null;
                        string tmpUrl = RecBlueSiteUrl;
                        for (int i = 0; i < BoardLinkTargets.GetLength(0); i++)
                        {
                            if (tmpLower != BoardLinkTargets[i, 0] && tmpLower != BoardLinkTargets[i, 1].ToLowerInvariant()) continue;
                            tmpReplacement = BoardLinkTargets[i, 1];
                            tmpUrl = BoardLinkTargets[i, 2];
                            break;
                        }
                        if (tmpReplacement == null) continue;
                        // Le libelle change tout de suite, meme si le clic ne peut pas etre repris.
                        try { if (tmp.text != tmpReplacement) tmp.text = tmpReplacement; } catch { }
                        Button tmpButton = FindClickable(tmp.transform);
                        if (tmpButton == null)
                        {
                            string tmpPath = PathOf(tmp.transform, 6);
                            if (!missingLogged.Contains("tmp:" + tmpPath))
                            {
                                missingLogged.Add("tmp:" + tmpPath);
                                BrandingPlugin.Trace.LogInfo("tableau : pas de bouton pour \"" + tmpText + "\" (" + tmpPath + ")");
                                BrandingPlugin.Trace.LogInfo("tableau : chaine \"" + tmpText + "\" : " + ComponentChain(tmp.transform, 6));
                            }
                            continue;
                        }
                        int tmpId = tmpButton.GetInstanceID();
                        if (!relinkedButtons.Contains(tmpId))
                        {
                            relinkedButtons.Add(tmpId);
                            try { tmpButton.onClick.RemoveAllListeners(); } catch { }
                            try
                            {
                                string tmpTarget = tmpUrl;
                                UnityEngine.Events.UnityAction tmpAction =
                                    Il2CppInterop.Runtime.DelegateSupport.ConvertDelegate<UnityEngine.Events.UnityAction>(new Action(() => OpenUrl(tmpTarget)));
                                tmpButton.onClick.AddListener(tmpAction);
                            }
                            catch (Exception error)
                            {
                                BrandingPlugin.Trace.LogWarning("tableau : clic non remplace (" + error.Message + ")");
                            }
                            boardLinkTotal++;
                            changed++;
                            BrandingPlugin.Trace.LogInfo("tableau : \"" + tmpText + "\" -> \"" + tmpReplacement + "\" (" + PathOf(tmp.transform, 6) + ")");
                        }
                    }
                }
                // Une seule fois, les libelles du tableau : si le jeu nomme un bouton
                // autrement que prevu, la ligne le dit au lieu de ne rien faire en silence.
                if (!boardLinkDumped)
                {
                    List<string> seen = new List<string>();
                    if (tmps.Count > 0)
                    {
                        foreach (TMP_Text tmp in tmps)
                        {
                            if (tmp == null || seen.Count >= 12) continue;
                            if (!IsBoard(tmp.transform)) continue;
                            string tmpSeen = "";
                            try { tmpSeen = (tmp.text ?? "").Trim(); } catch { }
                            if (tmpSeen.Length == 0 || tmpSeen.Length > 40 || seen.Contains(tmpSeen)) continue;
                            seen.Add(tmpSeen);
                        }
                    }
                    foreach (Text label in labels)
                    {
                        if (label == null) continue;
                        if (!IsBoard(label.transform)) continue;
                        string text = "";
                        try { text = (label.text ?? "").Trim(); } catch { }
                        if (text.Length == 0 || text.Length > 40 || seen.Contains(text)) continue;
                        seen.Add(text);
                        if (seen.Count >= 12) break;
                    }
                    if (seen.Count > 0)
                    {
                        boardLinkDumped = true;
                        BrandingPlugin.Trace.LogInfo("tableau : libelles vus (" + seen.Count + ") : " + string.Join(" | ", seen.ToArray()));
                    }
                }
                if (changed > 0 && now >= nextBoardLinkLog)
                {
                    nextBoardLinkLog = now + 5f;
                    BrandingPlugin.Trace.LogInfo("tableau : " + boardLinkTotal + " bouton(s) Rec Room repris vers " + RecBlueSiteUrl);
                }
                if (EnableRewardLogo && boardRoot != null) ApplyRewardLogo(boardRoot);
                float passMs = (Time.realtimeSinceStartup - passStart) * 1000f;
                if (passMs > 8f) BrandingPlugin.Trace.LogInfo("tableau : passe " + Mathf.RoundToInt(passMs) + " ms");
            }
            catch { }
        }

        // ------------------------------------------------------ image de la recompense
        // Le panneau du defi affiche l'objet a gagner dans `[RewardDisplay]`. Cette image
        // est dessinee par le client (aucun champ du serveur ne la porte) : on remplace le
        // visuel par le logo REC BLUE, sans toucher a la mise en page du panneau — le
        // cadre, la position et l'echelle restent ceux du jeu.
        //
        // On ne remplace que le PLUS GRAND visuel non textuel de cet emplacement : c'est
        // l'image de l'objet, les autres sont le fond et les ornements du cadre.
        private static void EnsureRewardLogo()
        {
            if (rewardLogoLoaded) return;
            rewardLogoLoaded = true;
            rewardLogo = Load("RecBlueRewardLogo.png");
            if (rewardLogo == null)
            {
                BrandingPlugin.Trace.LogWarning("defi : logo RecBlueRewardLogo.png introuvable.");
                return;
            }
            rewardLogoSprite = Sprite.Create(rewardLogo, new Rect(0f, 0f, rewardLogo.width, rewardLogo.height), new Vector2(0.5f, 0.5f));
            rewardLogoSprite.name = "RecBlueRewardLogo";
        }

        private void ApplyRewardLogo(Transform boardRoot)
        {
            EnsureRewardLogo();
            if (rewardLogo == null) return;
            Transform display = FindRewardDisplay(boardRoot);
            if (display == null) return;
            List<Graphic> visuals = new List<Graphic>();
            CollectRewardGraphics(display, visuals, 0);
            // Une seule fois : ce que contient l'emplacement, pour savoir sur quoi on est
            // tombe si le jeu renomme ses objets.
            if (!rewardVisuals.Contains("inv"))
            {
                rewardVisuals.Add("inv");
                List<string> seen = new List<string>();
                foreach (Graphic visual in visuals)
                {
                    if (visual == null || seen.Count >= 10) continue;
                    string kind;
                    try { kind = visual.GetType().Name; } catch { kind = "?"; }
                    Rect size;
                    try { size = visual.rectTransform.rect; } catch { size = default(Rect); }
                    seen.Add(kind + " " + Mathf.RoundToInt(size.width) + "x" + Mathf.RoundToInt(size.height) + " " + PathOf(visual.transform, 8));
                }
                if (seen.Count > 0)
                    BrandingPlugin.Trace.LogInfo("defi : visuels de [RewardDisplay] (" + seen.Count + ") : " + string.Join(" | ", seen.ToArray()));
            }
            // Le visuel de l'objet porte un nom parlant quand il y en a un ; sinon c'est le
            // plus grand — l'image de la recompense occupe l'emplacement, le fond et les
            // ornements sont plus petits.
            Graphic best = null;
            float bestArea = 0f;
            Graphic largest = null;
            float largestArea = 0f;
            foreach (Graphic visual in visuals)
            {
                if (visual == null) continue;
                Rect box;
                try { box = visual.rectTransform.rect; } catch { continue; }
                float area = Mathf.Abs(box.width * box.height);
                if (area > largestArea) { largestArea = area; largest = visual; }
                string lower = "";
                try { lower = (visual.gameObject.name ?? "").ToLowerInvariant(); } catch { }
                bool artLike = lower.Contains("image") || lower.Contains("icon") || lower.Contains("art")
                    || lower.Contains("thumb") || lower.Contains("preview") || lower.Contains("gift")
                    || lower.Contains("reward") || lower.Contains("skin");
                if (!artLike || area <= bestArea) continue;
                bestArea = area;
                best = visual;
            }
            if (best == null) best = largest;
            if (best == null) return;
            string path = PathOf(best.transform, 8);
            try
            {
                Image image = best.TryCast<Image>();
                if (image != null)
                {
                    image.sprite = rewardLogoSprite;
                    image.preserveAspect = true;
                    image.color = Color.white;
                }
                else
                {
                    RawImage raw = best.TryCast<RawImage>();
                    if (raw == null) return;
                    raw.texture = rewardLogo;
                    raw.color = Color.white;
                }
            }
            catch { return; }
            if (!rewardVisuals.Contains(path))
            {
                rewardVisuals.Add(path);
                BrandingPlugin.Trace.LogInfo("defi : image de la recompense remplacee par le logo REC BLUE (" + path + ")");
            }
        }

        // L'emplacement de la recompense, par son nom (`[RewardDisplay]` dans le jeu).
        private static Transform FindRewardDisplay(Transform boardRoot)
        {
            try
            {
                GameObject direct = GameObject.Find("[RewardDisplay]");
                if (direct != null) return direct.transform;
            }
            catch { }
            return FindChildByName(boardRoot, "RewardDisplay", 0);
        }

        private static Transform FindChildByName(Transform root, string name, int depth)
        {
            if (root == null || depth > 12) return null;
            string current;
            try { current = root.name ?? ""; } catch { current = ""; }
            if (current.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0) return root;
            int count;
            try { count = root.childCount; } catch { return null; }
            for (int i = 0; i < count; i++)
            {
                Transform child;
                try { child = root.GetChild(i); } catch { continue; }
                Transform hit = FindChildByName(child, name, depth + 1);
                if (hit != null) return hit;
            }
            return null;
        }

        // Les visuels de l'emplacement, sauf les textes (le libelle de la recompense vit la).
        private static void CollectRewardGraphics(Transform root, List<Graphic> found, int depth)
        {
            if (root == null || depth > 10) return;
            bool isText = false;
            try { isText = root.GetComponent<Text>() != null || root.GetComponent<TMP_Text>() != null; }
            catch { }
            if (!isText)
            {
                try
                {
                    Graphic graphic = root.GetComponent<Graphic>();
                    if (graphic != null) found.Add(graphic);
                }
                catch { }
            }
            int count;
            try { count = root.childCount; } catch { return; }
            for (int i = 0; i < count; i++)
            {
                Transform child;
                try { child = root.GetChild(i); } catch { continue; }
                CollectRewardGraphics(child, found, depth + 1);
            }
        }

        // Le bouton cliquable qui porte ce libelle : le texte est souvent un enfant du
        // bouton, pas le bouton lui-meme.
        // Le panneau du tableau et le mur des boutons d'aide, trouves par leur nom.
        private static Transform FindBoardRoot(string name)
        {
            try
            {
                // Les objets du tableau s'appellent « [CommunityBoard] » (crochets compris).
                GameObject go = GameObject.Find(name);
                if (go != null) return go.transform;
                go = GameObject.Find("[" + name + "]");
                return go == null ? null : go.transform;
            }
            catch { return null; }
        }

        // Libelles du tableau seulement : on descend l'arbre du panneau au lieu de parcourir
        // la scene entiere. Le cout passe de ~20 ms a moins d'une milliseconde.
        private static void CollectBoardLabels(Transform root, List<Text> texts, List<TextMesh> meshes, List<TMP_Text> tmps)
        {
            if (root == null) return;
            try
            {
                TMP_Text tmp = root.GetComponent<TMP_Text>();
                if (tmp != null) tmps.Add(tmp);
            }
            catch { }
            try
            {
                Text label = root.GetComponent<Text>();
                if (label != null) texts.Add(label);
            }
            catch { }
            try
            {
                TextMesh mesh = root.GetComponent<TextMesh>();
                if (mesh != null) meshes.Add(mesh);
            }
            catch { }
            int count;
            try { count = root.childCount; }
            catch { return; }
            for (int i = 0; i < count; i++)
            {
                Transform child;
                try { child = root.GetChild(i); }
                catch { continue; }
                CollectBoardLabels(child, texts, meshes, tmps);
            }
        }

        // Ancetres d'un libelle et composants de chacun : sert a trouver qui gere le clic.
        private static string ComponentChain(Transform start, int depth)
        {
            System.Text.StringBuilder chain = new System.Text.StringBuilder();
            Transform current = start;
            int guard = 0;
            while (current != null && guard++ < depth)
            {
                chain.Append(current.name).Append('[');
                try
                {
                    Component[] parts = current.GetComponents<Component>();
                    for (int i = 0; i < parts.Length; i++)
                    {
                        if (i > 0) chain.Append(',');
                        if (parts[i] == null) { chain.Append("?"); continue; }
                        try { chain.Append(parts[i].GetType().FullName); } catch { chain.Append("?"); }
                    }
                }
                catch { chain.Append('?'); }
                chain.Append("] < ");
                current = current.parent;
            }
            return chain.ToString();
        }

        private static Button FindClickable(Transform start)
        {
            Transform current = start;
            int guard = 0;
            while (current != null && guard++ < 8)
            {
                Button button = current.GetComponent<Button>();
                if (button != null) return button;
                current = current.parent;
            }
            return null;
        }

        // Les boutons du tableau ne sont pas des Button Unity : ils passent par un composant
        // Rec Room qui finit par ouvrir une URL. On intercepte donc l'ouverture de lien :
        // tout lien Rec Room / Instagram / YouTube part sur le site.
        private static bool openUrlBusy;
        private static bool OpenUrlPrefix(string url)
        {
            try
            {
                if (openUrlBusy) return true;
                string lower = (url ?? "").ToLowerInvariant();
                bool stranger = lower.Contains("recroom.com") || lower.Contains("instagram.com")
                    || lower.Contains("youtube.com") || lower.Contains("youtu.be")
                    || lower.Contains("zendesk") || lower.Contains("discord.gg")
                    || (lower.Contains("rec.net") && !lower.Contains("recblue"));
                BrandingPlugin.Trace.LogInfo("tableau : lien du jeu -> " + url);
                if (!stranger) return true;
                openUrlBusy = true;
                try { Application.OpenURL(RecBlueSiteUrl); }
                finally { openUrlBusy = false; }
                BrandingPlugin.Trace.LogInfo("tableau : " + url + " remplace par " + RecBlueSiteUrl);
                return false;
            }
            catch { return true; }
        }

        private static bool supportLinkPatchTried;

        // Le client ecrit « For more information, please contact us at recroom.zendesk.com »
        // sur l'ecran de compte banni. Ce n'est pas une chaine du serveur : la seule prise
        // est le libelle lui-meme. Le IndexOf passe avant toute allocation, donc les
        // libelles innombrables du jeu ne paient rien.
        internal static string RewriteSupportLinks(string value)
        {
            if (string.IsNullOrEmpty(value)) return value;
            if (value.IndexOf("recroom.zendesk.com", StringComparison.OrdinalIgnoreCase) < 0) return value;
            return value.Replace("recroom.zendesk.com", "support@recblue.net");
        }

        private static bool SupportLinkPrefix(ref string value, TMPro.TMP_Text __instance)
        {
            try { value = RewriteSupportLinks(value); } catch { }
            try { HideBanAppealButton(value, __instance); } catch { }
            return true;
        }

        // Le menu de la montre n'ecrit pas via la propriete : il appelle SetText(...). Le
        // prefixe vise le premier argument, quel que soit son nom dans la signature.
        private static void SupportLinkArgPrefix(ref string __0, TMPro.TMP_Text __instance)
        {
            try { __0 = RewriteSupportLinks(__0); } catch { }
            try { HideBanAppealButton(__0, __instance); } catch { }
        }

        /// <summary>
        /// Retire le bouton « Ban appeal code » de l'ecran « Account Status ». Ce bouton
        /// n'ouvre rien chez nous : son appel recharge la piece et renvoie le joueur au
        /// dortoir, ou la presence du serveur prive le fait dire « out-of-sync » a chaque
        /// battement — constate en jeu, et disparu des qu'on entre dans une vraie chambre.
        /// On desactive le bouton au moment ou son libelle est pose : pas de hook natif,
        /// seulement des appels geres, donc aucun risque de plantage au demarrage.
        /// </summary>
        private static void HideBanAppealButton(string value, TMPro.TMP_Text text)
        {
            if (text == null || string.IsNullOrEmpty(value)) return;
            if (value.IndexOf("appeal", StringComparison.OrdinalIgnoreCase) < 0) return;
            if (appealLabelSeen.Add(text.GetInstanceID()))
                BrandingPlugin.Trace.LogInfo("ban : libelle \"" + value + "\" vu sur " + ComponentChain(text.transform, 6));
            Transform node = text.transform;
            for (int depth = 0; depth < 6 && node != null; depth++)
            {
                Component[] components = node.GetComponents<Component>();
                for (int i = 0; i < components.Length; i++)
                {
                    Component component = components[i];
                    if (component == null) continue;
                    string type = component.GetType().Name;
                    if (type.IndexOf("Button", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    if (node.gameObject.activeSelf) node.gameObject.SetActive(false);
                    return;
                }
                node = node.parent;
            }
            // Pas de composant bouton sur le chemin : on masque au moins le libelle, pour
            // qu'aucune mention d'un appel impossible ne reste a l'ecran.
            if (text.gameObject.activeSelf) text.gameObject.SetActive(false);
        }

        private static readonly System.Collections.Generic.HashSet<int> appealLabelSeen = new System.Collections.Generic.HashSet<int>();
        private static readonly System.Collections.Generic.HashSet<string> banAppealHidden = new System.Collections.Generic.HashSet<string>();
        private static float nextBanAppealScan;

        /// <summary>
        /// Masque le bouton « Ban appeal code » par son NOM d'objet, sans dependre du texte :
        /// le libelle de ce bouton n'est pas pose par les chemins que le plugin intercepte
        /// (constate en jeu le 13/11, avec la DLL a jour chargee). Un balayage toutes les
        /// 3 s suffit — un bouton d'ecran de ban n'a pas besoin d'etre masque au frame pres.
        /// </summary>
        internal static void BanAppealScanTick(float now)
        {
            if (now < nextBanAppealScan) return;
            nextBanAppealScan = now + 3f;
            Transform[] all;
            float started = Time.realtimeSinceStartup;
            try { all = Resources.FindObjectsOfTypeAll<Transform>(); }
            catch { return; }
            for (int i = 0; i < all.Length; i++)
            {
                Transform node = all[i];
                if (node == null) continue;
                string name;
                try { name = node.name; } catch { continue; }
                if (string.IsNullOrEmpty(name)) continue;
                if (name.IndexOf("appeal", StringComparison.OrdinalIgnoreCase) < 0) continue;
                bool active = false;
                try { active = node.gameObject.activeSelf; } catch { }
                if (!active) continue;
                try { node.gameObject.SetActive(false); } catch { continue; }
                if (banAppealHidden.Add(name))
                    BrandingPlugin.Trace.LogInfo("ban : bouton \"" + name + "\" masque (" + ComponentChain(node, 4) + ")");
            }
            float ms = (Time.realtimeSinceStartup - started) * 1000f;
            if (ms > 30f) BrandingPlugin.Trace.LogInfo("ban : balayage des boutons " + Mathf.RoundToInt(ms) + " ms");
        }

        // Une methode DECLAREE (sans corps) ne doit pas etre patchee : c'est ce qui a fait
        // fermer le jeu le 12/11 (hook installe, puis plantage natif au premier appel).
        private static bool HasBody(System.Reflection.MethodInfo method)
        {
            try { return method != null && !method.IsAbstract && method.GetMethodBody() != null; }
            catch { return false; }
        }

        internal static void InstallSupportLinkRewrite(BepInEx.Logging.ManualLogSource log)
        {
            if (supportLinkPatchTried) return;
            supportLinkPatchTried = true;
            try
            {
                // Uniquement l'implementation du client : patcher la methode declaree
                // TMPro.TMP_Text::set_text fait planter le jeu au demarrage (mesure du
                // 12/11 : hook installe, puis fermeture immediate, sans exception geree).
                System.Reflection.MethodInfo setter = HarmonyLib.AccessTools.PropertySetter(typeof(TMPro.TextMeshProUGUI), "text");
                if (setter == null)
                {
                    log.LogWarning("ban : ecrivain de texte TextMeshProUGUI introuvable.");
                    return;
                }
                System.Reflection.MethodInfo prefix = typeof(BrandingScan).GetMethod("SupportLinkPrefix", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic);
                System.Reflection.MethodInfo argPrefix = typeof(BrandingScan).GetMethod("SupportLinkArgPrefix", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic);
                HarmonyLib.Harmony harmony = new HarmonyLib.Harmony("rec.blue.supportlink");
                harmony.Patch(setter, prefix: new HarmonyLib.HarmonyMethod(prefix));

                // Le repertoire de la montre passe par SetText(...) et non par la propriete :
                // sans ce hook, l'ecran « Account Status » gardait « recroom.zendesk.com »
                // alors que le tableau affichait deja la bonne adresse (constate en jeu).
                int setTextPatched = 0;
                System.Reflection.MethodInfo[] methods = typeof(TMPro.TMP_Text).GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance);
                for (int i = 0; i < methods.Length; i++)
                {
                    if (methods[i].Name != "SetText") continue;
                    System.Reflection.ParameterInfo[] parameters = methods[i].GetParameters();
                    if (parameters.Length == 0 || parameters[0].ParameterType != typeof(string)) continue;
                    if (!HasBody(methods[i])) continue;
                    try
                    {
                        harmony.Patch(methods[i], prefix: new HarmonyLib.HarmonyMethod(argPrefix));
                        setTextPatched++;
                    }
                    catch (Exception error)
                    {
                        log.LogWarning("ban : SetText(" + parameters.Length + " args) non patche (" + error.Message + ")");
                    }
                }
                log.LogInfo("ban : adresse de support reecrite vers support@recblue.net (propriete + " + setTextPatched + " SetText).");
            }
            catch (Exception error)
            {
                log.LogWarning("ban : reecriture du texte impossible (" + error.Message + ")");
            }
        }

        private static void InstallOpenUrlRedirect(BepInEx.Logging.ManualLogSource log)
        {
            try
            {
                HarmonyLib.Harmony harmony = new HarmonyLib.Harmony("rec.blue.openurl");
                System.Reflection.BindingFlags flags = System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic;
                System.Reflection.MethodInfo prefix = typeof(BrandingScan).GetMethod("OpenUrlPrefix", flags);
                System.Reflection.MethodInfo[] methods = typeof(UnityEngine.Application).GetMethods(System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public);
                int installed = 0;
                System.Text.StringBuilder seen = new System.Text.StringBuilder();
                for (int i = 0; i < methods.Length; i++)
                {
                    if (methods[i].Name.IndexOf("URL", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    seen.Append(methods[i].Name).Append(' ');
                    System.Reflection.ParameterInfo[] parameters = methods[i].GetParameters();
                    if (parameters.Length != 1 || parameters[0].ParameterType != typeof(string)) continue;
                    try
                    {
                        harmony.Patch(methods[i], prefix: new HarmonyLib.HarmonyMethod(prefix));
                        installed++;
                    }
                    catch (Exception error)
                    {
                        log.LogWarning("liens : patch de " + methods[i].Name + " refuse (" + error.Message + ")");
                    }
                }
                log.LogInfo("liens : methodes URL vues (" + seen.ToString().Trim() + "), " + installed + " interception(s) posee(s) vers " + RecBlueSiteUrl + ".");
            }
            catch (Exception error)
            {
                log.LogWarning("liens : interception impossible (" + error.Message + ")");
            }
        }

        private static void OpenUrl(string url)
        {
            try
            {
                BrandingPlugin.Trace.LogInfo("tableau : ouverture de " + url);
                Application.OpenURL(url);
            }
            catch (Exception error)
            {
                BrandingPlugin.Trace.LogWarning("tableau : ouverture impossible (" + error.Message + ")");
            }
        }

        private static void RawImageTexturePostfix(RawImage __instance, Texture value)
        {
            if (__instance == null) return;
            float now = Time.realtimeSinceStartup;
            if (now < 10f) return;
            Rect box = default(Rect);
            try { box = __instance.rectTransform.rect; } catch { return; }
            if (box.width < 300f || box.height < 120f) return;
            TintBackgroundsForGraphic(__instance);
            if (rawPanelLogged) return;
            rawPanelLogged = true;
            string path = "";
            string textureName = "";
            int width = 0;
            int height = 0;
            try { path = PathOf(__instance.transform, 6); } catch { }
            try { if (value != null) { textureName = value.name ?? ""; width = value.width; height = value.height; } } catch { }
            Color rawColour = Color.white;
            try { rawColour = __instance.color; } catch { }
            BrandingPlugin.Trace.LogInfo("panneau raw : " + path + " " + width + "x" + height + " tex=" + textureName + " color=" + rawColour);
        }

        private bool titleTickSeen;

        // Appele par Application.onBeforeRender : ce chemin ne depend ni de l'activation
        // du GameObject ni du changement de scene, contrairement a Update.
        internal void TickTitle()
        {
            if (!titleTickSeen)
            {
                titleTickSeen = true;
                BrandingPlugin.Trace.LogInfo("titre : pilote global actif.");
            }
            ApplyTitleOnce(Time.realtimeSinceStartup);
        }

        private bool quietReported;

        private static readonly string[] LogoSprites =
        {
            "RecRoomLogo",
            "RecRoom_Logo",
            "RecRoomLogo_Sprite",
            "RecRoomLogo_Sprite_Shadow",
            "Illustration_RecRoomLogo",
            "RecRoom_Logo_SteamSplash_Tex",
            "RecRoom_Logo_OculusSplash_Tex",
            "RecRoom_Logo_VirtualRealitySplashImage"
        };

        private static readonly Color Accent = new Color(0.945f, 0.353f, 0.145f);
        private static readonly Color AccentDark = new Color(0.840f, 0.254f, 0.000f);
        private static readonly Color AccentLight = new Color(0.878f, 0.424f, 0.129f);

        private static Texture2D title;
        internal static Sprite titleSprite;
        private bool titleApplied;
        private float nextTitleApplyAt;
        private int titleApplyPasses;

        // Titre leger pour le login et les ecrans de chargement uniquement.
        private static Texture2D loadingTitleTexture;
        private static Sprite loadingTitleSprite;
        private static bool loadingTitleLoaded;
        private static float nextLoadingTitleAt;
        private static bool loadingTitleLogged;
        private static bool loadingPercentLogged;
        private static float nextLoadingPercentAt;
        // La carte de login apparait apres l'enumeration graphique : ses libelles
        // TextMeshPro restaient oranges. On ne teinte que ces TMP-la.
        private static bool loginTextLogged;

        // Deux images imbriquees portent le logo du login : leurs echelles se composent
        // (k x k). Pour que le logo occupe la largeur de celui de Rec Room (mesure sur une
        // capture sans branding : 248 px contre 227 px au repos), le facteur par image est
        // donc la racine du rapport, soit 1.045. L'echelle d'origine est memorisee pour que
        // la reapplication ne compose jamais le facteur.
        private const float LoginLogoScale = 1.045f;
        private readonly Dictionary<Transform, Vector3> logoBaseScales = new Dictionary<Transform, Vector3>();
        private bool loginScaleLogged;

        private readonly HashSet<string> seenPalettes = new HashSet<string>();
        private readonly HashSet<int> seenTextures = new HashSet<int>();
        private readonly List<Texture2D> queue = new List<Texture2D>();
        private readonly Dictionary<int, Texture2D> recoloured = new Dictionary<int, Texture2D>();
        private readonly Dictionary<int, Sprite> newSprites = new Dictionary<int, Sprite>();

        private float nextSweep;
        private float nextEnqueue;
        private int sweeps;
        private int palettePasses;
        private int texturesDone;
        private bool rebound;
        private bool diagnosed;
        private float lastDiagnose;
        private bool perfApplied;
        private float startedAt;
        private float nextRebind;
        private readonly HashSet<int> scaledImages = new HashSet<int>();
        private int loginAttempts;
        private float burstUntil;
        private int canvasSeen = -1;
        private float nextCanvasCheck;
        private bool sceneHooked;
        private float lateTintAt;
        private float lateTintAllowedAt;
        private bool lateTintLogged;
        private static int panelLogs;
        private static int panelSeenLogs;
        private static float nextPanelTintAt;
        private bool boardPaintRequested;
        private int boardTextureRuns;
        private float nextBoardTextureAt;
        private float nextWorldBoardAt;
        private Material boardMaterial;
        private Texture2D boardBlueTexture;
        private readonly HashSet<int> boardTextureChecked = new HashSet<int>();
        private bool boardDiagShown;
        private bool boardTexturesDone;
        // Tableau de la Dorm Room : les deux passes de conversion de TEXTURES restent
        // coupees. Elles touchaient MenuIcon_Sprites(HR), un atlas partage par toute
        // l'interface, et changeaient donc la couleur d'elements hors du tableau.
        // Seule la teinte des panneaux du tableau (couleur des Graphiques) est active.
        private static readonly bool KeepOriginalBoard = true;
        private static bool rawPanelLogged;


        // Premiere fenetre de travail apres le lancement. Ensuite on ne recolore plus que
        // les ecrans qui arrivent (salves), pour ne pas payer de cout permanent.
        private const float Window = 40f;
        // Le demarrage du jeu charge ses propres bundles : convertir des textures pendant ce
        // temps faisait bugger le debut de partie. On laisse le jeu respirer 8 s.
        private const float StartDelay = 8f;
        // Au-dela, plus aucune conversion de texture ni rebind : le rendu prime (exigence
        // n1). La repeinte legere continue seule pour que le bleu tienne au clic.
        private const float BrandWindow = 20f;
        // Conversion des textures (orange -> bleu) et conversion de palette : coupees.
        // Chaque blit coute une frame entiere et c'est la source des gels. Le titre, la
        // configuration fps et la repeinte legere des boutons restent actifs.
        // Reglage de vitesse, lu dans RECBLUE_MODE.txt et relu toutes les 5 s :
        //   fluent   = aucune conversion de texture, fluidite maximale
        //   balanced = petites planches seulement (<= 512 px)
        //   branding = planches jusqu'a 2048 px (atlases RRUI), gels courts
        private const string ModeFile = "C:/RecRoom2023/BepInEx/plugins/RECBLUE_MODE.txt";
        private static readonly string ModeFileDefault =
            "# REC BLUE - reglage du bleu (relu toutes les 5 s, sans recompiler)\n" +
            "# fluent   : textes seulement\n" +
            "# balanced : textes et panneaux\n" +
            "# branding : textes et panneaux (defaut)\n" +
            "mode=branding\n";
        private bool paintTextures = true;
        private int paintCap = 2048;
        private string paintMode = "";
        private float nextModeRead;
        private bool modeFileChecked;

        private void ReadMode()
        {
            float now = Time.realtimeSinceStartup;
            if (now < nextModeRead) return;
            nextModeRead = now + 5f;
            string mode = "branding";
            try
            {
                if (!modeFileChecked)
                {
                    modeFileChecked = true;
                    if (!System.IO.File.Exists(ModeFile)) System.IO.File.WriteAllText(ModeFile, ModeFileDefault);
                }
                if (System.IO.File.Exists(ModeFile))
                {
                    string text = System.IO.File.ReadAllText(ModeFile);
                    foreach (string raw in text.Split('\n'))
                    {
                        string line = raw.Trim();
                        if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal)) continue;
                        int equals = line.IndexOf('=');
                        if (equals < 0) continue;
                        if (!line.Substring(0, equals).Trim().Equals("mode", StringComparison.OrdinalIgnoreCase)) continue;
                        string value = line.Substring(equals + 1).Trim().ToLowerInvariant();
                        if (value.Length > 0) mode = value;
                    }
                }
            }
            catch { }
            // Consigne : le bleu ne reste que sur les textes et les panneaux. Plus de
            // conversion de textures ni d'icones — c'etait aussi le gel de 528 ms.
            bool textures = false;
            int cap = 512;
            if (mode == paintMode && textures == paintTextures && cap == paintCap) return;
            paintMode = mode;
            paintTextures = textures;
            paintCap = cap;
            BrandingPlugin.Trace.LogInfo("reglage : mode=" + paintMode + " (textures=" + paintTextures + ", planches<=" + paintCap + " px)");
        }
        // Mode sans branding, active par la presence d'un fichier : le jeu garde seulement
        // la configuration fps. Permet de savoir si un probleme vient de nos ecritures
        // (titre, couleurs, textures) ou du jeu lui-meme, sans recompiler.
        private const string SafeMarker = "C:/RecRoom2023/BepInEx/plugins/RECBLUE_SAFE.txt";
        private static bool safeMode = false;
        private static bool safeChecked;

        private static Texture2D Load(string resource)
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            using (Stream stream = assembly.GetManifestResourceStream(resource))
            {
                if (stream == null) return null;
                byte[] bytes = new byte[stream.Length];
                int read = 0;
                while (read < bytes.Length) read += stream.Read(bytes, read, bytes.Length - read);
                Texture2D texture = new Texture2D(2, 2, TextureFormat.RGBA32, false);
                if (!ImageConversion.LoadImage(texture, bytes)) return null;
                texture.hideFlags = HideFlags.DontUnloadUnusedAsset;
                texture.name = resource;
                return texture;
            }
        }

        // Le halo blanc du titre est semi-transparent sur ses bords : le motif orange du
        // fond le traverse et le contour parait sale, avec des marches. On le rend opaque
        // d'un bord net, comme le liseré du logo Rec Room.
        private static void SolidifyTitleHalo(Texture2D texture)
        {
            try
            {
                Color32[] pixels = texture.GetPixels32();
                int changed = 0;
                for (int i = 0; i < pixels.Length; i++)
                {
                    byte a = pixels[i].a;
                    if (a == 0 || a == 255) continue;
                    pixels[i].a = a >= 150 ? (byte)255 : (byte)0;
                    changed++;
                }
                if (changed == 0) return;
                texture.SetPixels32(pixels);
                texture.Apply(false);
                BrandingPlugin.Trace.LogInfo("titre : halo rendu opaque (" + changed + " pixel(s)).");
            }
            catch { }
        }

        private void Prepare()
        {
            if (!BrandingPlugin.EnableLogoBranding) return;
            if (title != null) return;
            title = Load("RecBlueTitle.png");
            if (title == null) return;
            SolidifyTitleHalo(title);
            titleSprite = Sprite.Create(title, new Rect(0f, 0f, title.width, title.height), new Vector2(0.5f, 0.5f));
            titleSprite.name = "RecBlueTitle";
            BrandingPlugin.Trace.LogInfo("titre REC BLUE charge : " + title.width + "x" + title.height);
        }

        // Passe legere apres le chargement : les gardes couvrent les sprites, mais le
        // logo du login peut etre un RawImage ou avoir ete active avant le chargement de
        // RecBlueTitle. On enumere une seule fois les Images/RawImages actives, sans
        // relancer les gros balayages qui figeaient le jeu.
        private void ApplyTitleOnce(float now)
        {
            BrandingPlugin.TryStartTitleTimer();
            if (titleApplied || title == null || titleSprite == null) return;
            if (nextTitleApplyAt <= 0f) nextTitleApplyAt = 10f;
            if (now < nextTitleApplyAt) return;
            nextTitleApplyAt = now + 2f;
            titleApplyPasses++;
            int swapped = 0;
            try
            {
                Image[] images = UnityEngine.Object.FindObjectsOfType<Image>();
                foreach (Image image in images)
                {
                    if (image == null) continue;
                    Sprite current = null;
                    string name = "";
                    try { current = image.sprite; } catch { }
                    if (current != null) { try { name = current.name ?? ""; } catch { } }
                    string path = PathOf(image.transform, 8);
                    bool brand = IsBrandSprite(name);
                    if (!brand)
                    {
                        Rect box = default(Rect);
                        try { box = image.rectTransform.rect; } catch { }
                        if (box.width >= 300f && box.height >= 120f)
                            brand = IsBrandPath(PathOf(image.transform, 5));
                    }
                    if (!brand) continue;
                    if (!IsLoginLogoPath(path) && now < 6f) continue;
                    if (IsBrandShadowSprite(name))
                    {
                        try { image.enabled = false; } catch { }
                        continue;
                    }
                    try
                    {
                        image.sprite = titleSprite;
                        image.preserveAspect = true;
                        EnlargeLoginLogo(image);
                        if (logoCanaries.Count < 40 && !logoCanaries.Contains(image)) logoCanaries.Add(image);
                        swapped++;
                    }
                    catch { }
                }
            }
            catch { }
            try
            {
                RawImage[] raws = UnityEngine.Object.FindObjectsOfType<RawImage>();
                foreach (RawImage raw in raws)
                {
                    if (raw == null) continue;
                    Texture texture = null;
                    string name = "";
                    try { texture = raw.texture; } catch { }
                    if (texture != null) { try { name = texture.name ?? ""; } catch { } }
                    string path = PathOf(raw.transform, 8);
                    bool brand = name.IndexOf("RecRoomLogo", StringComparison.OrdinalIgnoreCase) >= 0
                        || name.IndexOf("RecRoom_Logo", StringComparison.OrdinalIgnoreCase) >= 0
                        || name.IndexOf("Rec Room Logo", StringComparison.OrdinalIgnoreCase) >= 0;
                    if (!brand)
                    {
                        Rect box = default(Rect);
                        try { box = raw.rectTransform.rect; } catch { }
                        if (box.width >= 300f && box.height >= 120f)
                            brand = IsBrandPath(PathOf(raw.transform, 5));
                    }
                    if (!brand) continue;
                    if (!IsLoginLogoPath(path) && now < 6f) continue;
                    try
                    {
                        raw.texture = title;
                        raw.uvRect = new Rect(0f, 0f, 1f, 1f);
                        swapped++;
                    }
                    catch { }
                }
            }
            catch { }
            if (swapped > 0)
            {
                titleApplied = true;
                BrandingPlugin.Trace.LogInfo("titre : logo REC BLUE applique (" + swapped + ").");
            }
            else if (titleApplyPasses >= 6) titleApplied = true;
        }

        // Le logo du BootUI n'a pas toujours un nom de sprite exploitable. On garde
        // la reconnaissance par chemin, avec un repli visuel borne aux grands logos
        // des ecrans de login/chargement (pas les panneaux ni les barres).
        private static bool IsLoadingTitleBrandPath(string path)
        {
            if (IsBrandPath(path)) return true;
            string p = path.ToLowerInvariant();
            return p.Contains("logo") || p.Contains("icon") || p.Contains("recroom");
        }

        private static bool LooksLikeLoadingTitle(Rect box, bool hasVisual, string path)
        {
            if (!hasVisual) return false;
            if (box.width < 250f || box.height < 150f) return false;
            if (box.width > 1400f || box.height > 1000f) return false;
            float ratio = box.width / Math.Max(1f, box.height);
            if (ratio < 0.7f || ratio > 2.0f) return false;
            string p = path.ToLowerInvariant();
            if (p.Contains("panel") || p.Contains("bar") || p.Contains("button")
                || p.Contains("background") || p.Contains("backdrop") || p.Contains("border")
                || p.Contains("frame") || p.Contains("shadow") || p.Contains("input")) return false;
            return true;
        }

        // Signale l'ecran de login (visible tant que son logo est present) : on y teinte
        // les libelles TextMeshPro oranges, sans toucher aux panneaux ni aux boutons.
        private static void NoteLoginScreen(float now)
        {
            if (!BrandingPlugin.EnableBlueUi || safeMode) return;
            TintLoginTexts();
        }

        // La carte de login apparait apres l'enumeration graphique : ses libelles
        // TextMeshPro restaient oranges. On ne teinte que les TMP oranges de cet ecran.
        private static void TintLoginTexts()
        {
            TMPro.TextMeshProUGUI[] tmps;
            try { tmps = UnityEngine.Object.FindObjectsOfType<TMPro.TextMeshProUGUI>(); } catch { return; }
            bool card = false;
            for (int i = 0; i < tmps.Length; i++)
            {
                TMPro.TextMeshProUGUI tmp = tmps[i];
                if (tmp == null) continue;
                string path = "";
                try { path = PathOf(tmp.transform, 6); } catch { }
                if (path.IndexOf("Switch account", StringComparison.OrdinalIgnoreCase) < 0) continue;
                card = true;
                break;
            }
            if (!card) return;
            int changed = 0;
            for (int i = 0; i < tmps.Length; i++)
            {
                TMPro.TextMeshProUGUI tmp = tmps[i];
                if (tmp == null || !tmp.enabled) continue;
                Color current;
                try { current = tmp.color; } catch { continue; }
                if (!IsRecOrange(current)) continue;
                try { tmp.color = ToRecBlue(current); changed++; } catch { }
            }
            if (changed > 0 && !loginTextLogged)
            {
                loginTextLogged = true;
                BrandingPlugin.Trace.LogInfo("login : " + changed + " texte(s) passe(s) en bleu.");
            }
        }

        // Passe volontairement limitee au login et au chargement.
        // guard Harmony et ne tourne pas a chaque frame : le jeu doit rester fluide.
        internal static void ApplyLoadingTitle(float now)
        {
            if (!BrandingPlugin.EnableLoadingTitle || safeMode) return;
            if (now < nextLoadingTitleAt) return;
            nextLoadingTitleAt = now + 0.75f;
            if (!loadingTitleLoaded)
            {
                loadingTitleLoaded = true;
                loadingTitleTexture = Load("RecBlueTitleWinter.png");
                if (loadingTitleTexture == null)
                {
                    BrandingPlugin.Trace.LogWarning("titre loading : image RecBlueTitleWinter.png introuvable.");
                    return;
                }
                loadingTitleSprite = Sprite.Create(loadingTitleTexture, new Rect(0f, 0f, loadingTitleTexture.width, loadingTitleTexture.height), new Vector2(0.5f, 0.5f), 100f);
                loadingTitleSprite.name = "RecBlueLoadingTitle";
                BrandingPlugin.Trace.LogInfo("titre loading : image chargee " + loadingTitleTexture.width + "x" + loadingTitleTexture.height + ".");
            }
            if (loadingTitleSprite == null) return;
            int swapped = 0;
            Image fallbackImage = null;
            RawImage fallbackRaw = null;
            try
            {
                Image[] images = UnityEngine.Object.FindObjectsOfType<Image>();
                foreach (Image image in images)
                {
                    if (image == null) continue;
                    string path = PathOf(image.transform, 8);
                    bool loginPath = IsLoginLogoPath(path);
                    bool loadingPath = IsLoadingLogoPath(path);
                    if (loginPath) NoteLoginScreen(now);
                    if (!loginPath && !loadingPath) continue;
                    Sprite current = null;
                    string name = "";
                    try { current = image.sprite; } catch { }
                    if (current != null) { try { name = current.name ?? ""; } catch { } }
                    Rect box = default(Rect);
                    try { box = image.rectTransform.rect; } catch { }
                    bool brand = IsBrandSprite(name) || IsLoadingTitleBrandPath(path);
                    if (!brand)
                    {
                        if (LooksLikeLoadingTitle(box, current != null, path))
                        {
                            NoteLoginScreen(now);
                            if (fallbackImage == null) fallbackImage = image;
                        }
                        continue;
                    }
                    // Un petit onglet/icone de chargement ne peut pas recevoir le wordmark :
                    // l'image serait etiree en colonne sombre. On garde le logo d'origine.
                    if (!LooksLikeLoadingTitle(box, current != null, path)) continue;
                    if (IsBrandShadowSprite(name))
                    {
                        try { image.enabled = false; } catch { }
                        continue;
                    }
                    try
                    {
                        if (image.sprite != loadingTitleSprite)
                        {
                            image.sprite = loadingTitleSprite;
                            image.preserveAspect = true;
                            swapped++;
                        }
                    }
                    catch { }
                }
            }
            catch { }
            try
            {
                RawImage[] raws = UnityEngine.Object.FindObjectsOfType<RawImage>();
                foreach (RawImage raw in raws)
                {
                    if (raw == null) continue;
                    string path = PathOf(raw.transform, 8);
                    bool loginPath = IsLoginLogoPath(path);
                    bool loadingPath = IsLoadingLogoPath(path);
                    if (!loginPath && !loadingPath) continue;
                    Texture current = null;
                    string name = "";
                    try { current = raw.texture; } catch { }
                    if (current != null) { try { name = current.name ?? ""; } catch { } }
                    Rect box = default(Rect);
                    try { box = raw.rectTransform.rect; } catch { }
                    bool brand = name.IndexOf("RecRoomLogo", StringComparison.OrdinalIgnoreCase) >= 0
                        || name.IndexOf("RecRoom_Logo", StringComparison.OrdinalIgnoreCase) >= 0
                        || name.IndexOf("Rec Room Logo", StringComparison.OrdinalIgnoreCase) >= 0
                        || IsLoadingTitleBrandPath(path);
                    if (!brand)
                    {
                        if (LooksLikeLoadingTitle(box, current != null, path))
                        {
                            NoteLoginScreen(now);
                            if (fallbackRaw == null) fallbackRaw = raw;
                        }
                        continue;
                    }
                    if (!LooksLikeLoadingTitle(box, current != null, path)) continue;
                    try
                    {
                        if (raw.texture != loadingTitleTexture)
                        {
                            raw.texture = loadingTitleTexture;
                            raw.uvRect = new Rect(0f, 0f, 1f, 1f);
                            swapped++;
                        }
                    }
                    catch { }
                }
            }
            catch { }
            if (swapped == 0 && fallbackImage != null)
            {
                try
                {
                    fallbackImage.sprite = loadingTitleSprite;
                    fallbackImage.preserveAspect = true;
                    swapped++;
                }
                catch { }
            }
            if (swapped == 0 && fallbackRaw != null)
            {
                try
                {
                    fallbackRaw.texture = loadingTitleTexture;
                    fallbackRaw.uvRect = new Rect(0f, 0f, 1f, 1f);
                    swapped++;
                }
                catch { }
            }
            if (swapped > 0)
            {
                if (!loadingTitleLogged)
                {
                    loadingTitleLogged = true;
                    BrandingPlugin.Trace.LogInfo("titre loading : " + swapped + " logo(s) remplace(s) par RecBlueTitleWinter.");
                }
            }
        }

        // Le client 2023 affiche parfois un carre a la place du signe pourcent, soit
        // parce que la chaine contient un caractere de remplacement, soit parce que la
        // police n'a pas le glyphe. On garde le nombre et on evite le carre.
        private static void FixLoadingPercent()
        {
            TextMeshProUGUI[] tmps;
            try { tmps = UnityEngine.Object.FindObjectsOfType<TextMeshProUGUI>(); } catch { return; }
            for (int i = 0; i < tmps.Length; i++)
            {
                TextMeshProUGUI tmp = tmps[i];
                if (tmp == null || !tmp.enabled) continue;
                string text;
                try { text = tmp.text; } catch { continue; }
                if (string.IsNullOrEmpty(text)) continue;
                string trimmed = text.Trim();
                if (trimmed.Length < 2) continue;
                char last = trimmed[trimmed.Length - 1];
                if (last != '%' && last != '\u25A1') continue;
                string number = trimmed.Substring(0, trimmed.Length - 1).Trim();
                if (number.Length == 0) continue;
                bool digits = true;
                for (int c = 0; c < number.Length; c++)
                {
                    if (!char.IsDigit(number[c])) { digits = false; break; }
                }
                if (!digits) continue;
                string path;
                try { path = PathOf(tmp.transform, 8); } catch { continue; }
                if (!IsLoadingLogoPath(path)) continue;
                bool hasPercent = false;
                try
                {
                    TMP_FontAsset font = tmp.font;
                    if (font != null) hasPercent = font.HasCharacter('%');
                }
                catch { }
                string updated;
                if (last == '\u25A1') updated = number + (hasPercent ? "%" : " / 100");
                else if (!hasPercent) updated = number + " / 100";
                else continue;
                try { tmp.text = updated; } catch { continue; }
                if (!loadingPercentLogged)
                {
                    loadingPercentLogged = true;
                    BrandingPlugin.Trace.LogInfo("chargement : signe pourcent absent de la police, nombre conserve (" + updated + ").");
                }
            }
        }

        // Version statique, appelee par Camera.Render : elle ne depend ni du composant
        // BrandingScan, ni de son Update, ni de la scene active.
        private static bool titleAppliedStatic;
        private static float nextStaticTitleAt;
        private static int staticTitlePasses;

        internal static bool TitleDone { get { return titleAppliedStatic; } }

        internal static void ApplyTitleStatic(bool fromLogin = false)
        {
            if (BrandingPlugin.EnableLoadingTitle && !safeMode) ApplyLoadingTitle(Time.realtimeSinceStartup);
            if (titleAppliedStatic || title == null || titleSprite == null) return;
            float now = Time.realtimeSinceStartup;
            if (now < 6f && !fromLogin) return;
            if (now < nextStaticTitleAt) return;
            nextStaticTitleAt = now + 2f;
            staticTitlePasses++;
            int swapped = 0;
            try
            {
                Image[] images = UnityEngine.Object.FindObjectsOfType<Image>();
                foreach (Image image in images)
                {
                    if (image == null) continue;
                    Sprite current = null;
                    string name = "";
                    try { current = image.sprite; } catch { }
                    if (current != null) { try { name = current.name ?? ""; } catch { } }
                    bool brand = IsBrandSprite(name);
                    if (!brand)
                    {
                        Rect box = default(Rect);
                        try { box = image.rectTransform.rect; } catch { }
                        if (box.width >= 300f && box.height >= 120f)
                            brand = IsBrandPath(PathOf(image.transform, 5));
                    }
                    if (!brand) continue;
                    string path = PathOf(image.transform, 8);
                    if (IsBrandShadowSprite(name))
                    {
                        try { image.enabled = false; } catch { }
                        continue;
                    }
                    try
                    {
                        image.sprite = titleSprite;
                        image.preserveAspect = true;
                        swapped++;
                    }
                    catch { }
                }
            }
            catch { }
            try
            {
                RawImage[] raws = UnityEngine.Object.FindObjectsOfType<RawImage>();
                foreach (RawImage raw in raws)
                {
                    if (raw == null) continue;
                    Texture texture = null;
                    string name = "";
                    try { texture = raw.texture; } catch { }
                    if (texture != null) { try { name = texture.name ?? ""; } catch { } }
                    bool brand = name.IndexOf("RecRoomLogo", StringComparison.OrdinalIgnoreCase) >= 0
                        || name.IndexOf("RecRoom_Logo", StringComparison.OrdinalIgnoreCase) >= 0
                        || name.IndexOf("Rec Room Logo", StringComparison.OrdinalIgnoreCase) >= 0;
                    if (!brand)
                    {
                        Rect box = default(Rect);
                        try { box = raw.rectTransform.rect; } catch { }
                        if (box.width >= 300f && box.height >= 120f)
                            brand = IsBrandPath(PathOf(raw.transform, 5));
                    }
                    if (!brand) continue;
                    try
                    {
                        raw.texture = title;
                        raw.uvRect = new Rect(0f, 0f, 1f, 1f);
                        swapped++;
                    }
                    catch { }
                }
            }
            catch { }
            if (swapped > 0)
            {
                titleAppliedStatic = true;
                BrandingPlugin.Trace.LogInfo("titre : logo REC BLUE applique (statique " + swapped + ").");
            }
            // Sans logo sur l'ecran courant, l'ancienne version relancait cette enumeration
            // complete toutes les 2 s indefiniment. On abandonne apres six essais, comme
            // ApplyTitleOnce : les gardes continuent de poser le titre si un logo apparait.
            else if (staticTitlePasses >= 6) titleAppliedStatic = true;
        }

        // ---------------------------------------------------------------- perf
        private static bool perfPriorityDone;
        private static float nextPerfAt;
        // Garde le handle : GetCurrentProcess() a chaque passage laissait un handle ouvert
        // toutes les 5 s pendant toute la session.
        private static System.Diagnostics.Process perfProcess;
        // Par defaut, aucun plafond : Application.targetFrameRate = -1. Le fichier
        // RECBLUE_FPS.txt permet de remettre un plafond sans recompiler.
        private const string FpsFile = "C:/RecRoom2023/BepInEx/plugins/RECBLUE_FPS.txt";

        private void ApplyPerf()
        {
            // Le jeu remet parfois ses propres reglages (priorite, cadence) : on verifie
            // regulierement, sans ouvrir un handle de processus a chaque image.
            float now = Time.realtimeSinceStartup;
            if (now < nextPerfAt) return;
            nextPerfAt = now + 5f;
            try
            {
                // maxQueuedFrames n'est plus force a 1 : avec une seule image en file,
                // le CPU attend le GPU a chaque image et la cadence plafonne. On remet
                // la valeur par defaut du moteur (2) si une ancienne build l'avait laissee.
                try
                {
                    if (QualitySettings.maxQueuedFrames == 1)
                    {
                        QualitySettings.maxQueuedFrames = 2;
                        BrandingPlugin.Trace.LogInfo("perf : maxQueuedFrames 1 -> 2 (pipeline)");
                    }
                }
                catch { }
                if (QualitySettings.vSyncCount != 0)
                {
                    BrandingPlugin.Trace.LogInfo("perf : vsync " + QualitySettings.vSyncCount + " -> 0");
                    QualitySettings.vSyncCount = 0;
                }
            }
            catch { }
            try
            {
                // Aucun plafond par defaut : -1 laisse le moteur produire autant d'images
                // que le CPU/GPU le permettent. Un fichier RECBLUE_FPS.txt peut poser
                // volontairement un plafond (par exemple fps=144).
                int screen = ScreenCap();
                int cap = FpsCap(screen);
                if (Application.targetFrameRate != cap)
                {
                    string current = Application.targetFrameRate < 0 ? "illimite" : Application.targetFrameRate.ToString();
                    string target = cap < 0 ? "illimite" : cap.ToString();
                    BrandingPlugin.Trace.LogInfo("perf : plafond fps " + current + " -> " + target + " (ecran " + screen + " Hz)");
                    Application.targetFrameRate = cap;
                }
            }
            catch { }
            try
            {
                // Le client remet sa priorite a Normal apres son initialisation : on la
                // remonte des qu'elle a bouge, sinon le gain ne tient pas la session.
                // AboveNormal et non High : en High, le thread de rendu peut affamer l'audio
                // et le reseau du meme process. Le plugin FPS applique la meme valeur, donc
                // les deux ne se contredisent plus.
                if (perfProcess == null) perfProcess = System.Diagnostics.Process.GetCurrentProcess();
                if (perfProcess.PriorityClass != System.Diagnostics.ProcessPriorityClass.AboveNormal)
                {
                    perfProcess.PriorityClass = System.Diagnostics.ProcessPriorityClass.AboveNormal;
                    if (!perfPriorityDone)
                        BrandingPlugin.Trace.LogInfo("perf : priorite process = AboveNormal");
                    else
                        BrandingPlugin.Trace.LogInfo("perf : priorite remise a AboveNormal (le jeu l'avait baissee)");
                    perfPriorityDone = true;
                }
            }
            catch (Exception error) { if (!perfPriorityDone) BrandingPlugin.Trace.LogWarning("perf : priorite refusee (" + error.Message + ")"); }
        }

        // Frequence de l'ecran, relue a chaque passage : un changement d'affichage
        // (casque, moniteur secondaire, mode fenetre) doit se refleter dans le plafond.
        private static int ScreenCap()
        {
            int hz = 0;
            try { hz = Screen.currentResolution.refreshRate; } catch { }
            if (hz < 30 || hz > 500) hz = 0;
            return hz;
        }

        // Le fichier RECBLUE_FPS.txt permet de choisir le plafond sans recompiler :
        //   absent   (defaut : illimite)
        //   fps=0    (illimite)
        //   fps=144  (plafond a 144 FPS)
        // Il est relu par ApplyPerf toutes les 5 s. -1 est la valeur Unity pour
        // "aucun plafond" ; une valeur positive ne depasse jamais la frequence ecran.
        private static int FpsCap(int screen)
        {
            int cap = -1;
            try
            {
                if (File.Exists(FpsFile))
                {
                    foreach (string raw in File.ReadAllLines(FpsFile))
                    {
                        string line = raw.Trim();
                        if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal)) continue;
                        int equals = line.IndexOf('=');
                        if (equals < 0) continue;
                        if (!line.Substring(0, equals).Trim().Equals("fps", StringComparison.OrdinalIgnoreCase)) continue;
                        int value;
                        if (!int.TryParse(line.Substring(equals + 1).Trim(), out value)) continue;
                        if (value <= 0) cap = -1;
                        else if (value >= 30 && value <= 500) cap = value;
                    }
                }
            }
            catch { }
            if (cap > 0 && screen > 0 && cap > screen) cap = screen;
            return cap;
        }

        // ---------------------------------------------------------------- couleurs
        private static float Distance(Color a, Color b)
        {
            return Mathf.Abs(a.r - b.r) + Mathf.Abs(a.g - b.g) + Mathf.Abs(a.b - b.b);
        }

        private static bool IsRecOrange(Color c)
        {
            if (c.a < 0.02f) return false;
            if (Distance(c, Accent) < 0.20f) return true;
            if (Distance(c, AccentDark) < 0.20f) return true;
            if (Distance(c, AccentLight) < 0.20f) return true;
            if (!(c.r > 0.55f && c.g > 0.12f && c.g < 0.62f && c.b < 0.42f && (c.r - c.g) > 0.18f)) return false;
            // Orange #F1761F -> 0,71 ; orange clair #FFB03C -> 1,46 ; or #FFC83D -> 2,52 ;
            // jaune pur -> 5,4. Seuil a 1,6 : tout l'orange passe, l'or des etoiles reste.
            float warmth = c.g - c.b;
            float redness = c.r - c.g;
            if (redness <= 0f) return false;
            return warmth <= redness * 1.6f;
        }

        private static Color ToRecBlue(Color c)
        {
            if (!BrandingPlugin.EnableBlueUi) return c;
            float h, s, v;
            Color.RGBToHSV(c, out h, out s, out v);
            Color blue = Color.HSVToRGB(0.615f, Mathf.Clamp01(s * 1.05f + 0.10f), Mathf.Clamp01(v * 1.02f));
            blue.a = c.a;
            return blue;
        }

        private const Il2CppSystem.Reflection.BindingFlags All =
            Il2CppSystem.Reflection.BindingFlags.Public
            | Il2CppSystem.Reflection.BindingFlags.NonPublic
            | Il2CppSystem.Reflection.BindingFlags.Instance;

        private static bool IsCompound(string typeName)
        {
            switch (typeName)
            {
                case "":
                case "Single":
                case "Double":
                case "Int32":
                case "Int64":
                case "UInt32":
                case "Boolean":
                case "String":
                case "Color":
                case "Color32":
                case "Vector2":
                case "Vector3":
                case "Vector4":
                case "Quaternion":
                case "Rect":
                case "Sprite":
                case "Texture2D":
                case "Material":
                case "Object":
                case "GameObject":
                case "Transform":
                    return false;
                default:
                    return true;
            }
        }

        private bool ConvertObject(Il2CppSystem.Object value, int depth, ref int changed)
        {
            if (value == null || depth > 4 || changed > 2000) return false;
            Il2CppSystem.Type type;
            try { type = value.GetIl2CppType(); } catch { return false; }
            if (type == null) return false;
            Il2CppSystem.Reflection.FieldInfo[] fields;
            try { fields = type.GetFields(All); } catch { return false; }
            if (fields == null) return false;

            bool touched = false;
            foreach (Il2CppSystem.Reflection.FieldInfo field in fields)
            {
                if (field == null) continue;
                string fieldType = "";
                try { fieldType = field.FieldType != null ? field.FieldType.Name : ""; } catch { }

                if (fieldType == "Color")
                {
                    Color current;
                    try
                    {
                        Il2CppSystem.Object boxed = field.GetValue(value);
                        if (boxed == null) continue;
                        current = boxed.Unbox<Color>();
                    }
                    catch { continue; }
                    if (!IsRecOrange(current)) continue;
                    try
                    {
                        field.SetValue(value, ToRecBlue(current).BoxIl2CppObject());
                        changed++;
                        touched = true;
                    }
                    catch { }
                    continue;
                }

                if (fieldType.EndsWith("[]", StringComparison.Ordinal) && depth < 4)
                {
                    Il2CppSystem.Object boxed;
                    try { boxed = field.GetValue(value); } catch { continue; }
                    if (boxed == null) continue;
                    Il2CppSystem.Array array = null;
                    try { array = boxed.TryCast<Il2CppSystem.Array>(); } catch { }
                    if (array == null) continue;
                    int length = 0;
                    try { length = array.Length; } catch { }
                    for (int i = 0; i < length && i < 120; i++)
                    {
                        Il2CppSystem.Object element;
                        try { element = array.GetValue(i); } catch { continue; }
                        if (element == null) continue;
                        if (!ConvertObject(element, depth + 1, ref changed)) continue;
                        try { array.SetValue(element, i); touched = true; } catch { }
                    }
                    continue;
                }

                if (depth < 4 && IsCompound(fieldType))
                {
                    bool valueType = true;
                    try
                    {
                        Il2CppSystem.Type childType = field.FieldType;
                        if (childType != null) valueType = childType.IsValueType;
                    }
                    catch { valueType = true; }
                    if (valueType) continue;
                    Il2CppSystem.Object child;
                    try { child = field.GetValue(value); } catch { continue; }
                    if (child == null) continue;
                    if (ConvertObject(child, depth + 1, ref changed)) touched = true;
                }
            }
            return touched;
        }

        // Dump unique des entrees de palette : c'est le seul moyen de savoir quelle entree
        // colore le bouton DONE et les cercles de selection, qui restent orange.
        private bool paletteDumped;

        private void DumpPalette(ScriptableObject asset)
        {
            if (paletteDumped) return;
            paletteDumped = true;
            try
            {
                Il2CppSystem.Type type = asset.GetIl2CppType();
                if (type == null) return;
                Il2CppSystem.Reflection.FieldInfo[] fields = type.GetFields(All);
                if (fields == null) return;
                foreach (Il2CppSystem.Reflection.FieldInfo field in fields)
                {
                    if (field == null) continue;
                    string fieldType = "";
                    try { fieldType = field.FieldType != null ? field.FieldType.Name : ""; } catch { }
                    if (fieldType != "Color") continue;
                    string name = "?";
                    try { name = field.Name ?? "?"; } catch { }
                    Color entry;
                    try
                    {
                        Il2CppSystem.Object boxed = field.GetValue(asset);
                        if (boxed == null) continue;
                        entry = boxed.Unbox<Color>();
                    }
                    catch { continue; }
                }
            }
            catch { }
        }

        private void PalettePass()
        {
            int changed = 0;
            string touchedTypes = "";
            try
            {
                ScriptableObject[] assets = Resources.FindObjectsOfTypeAll<ScriptableObject>();
                int scanned = 0;
                foreach (ScriptableObject asset in assets)
                {
                    if (scanned++ > 400) break;
                    if (asset == null) continue;
                    string typeName;
                    try
                    {
                        Il2CppSystem.Type type = asset.GetIl2CppType();
                        typeName = type != null ? (type.FullName ?? "?") : "?";
                    }
                    catch { continue; }

                    // Les boutons et barres sont dessines avec la couleur de la palette, pas
                    // dans leur texture (0 pixel orange dans les planches). Et le jeu
                    // reapplique son theme apres nos passes : memoriser les assets deja vus
                    // remettait l'orange definitivement, donc on reconvertit a chaque salve.
                    if (typeName.IndexOf("RRUI", StringComparison.OrdinalIgnoreCase) < 0
                        && typeName.IndexOf("Palette", StringComparison.OrdinalIgnoreCase) < 0
                        && typeName.IndexOf("Theme", StringComparison.OrdinalIgnoreCase) < 0
                        && typeName.IndexOf("ColorScheme", StringComparison.OrdinalIgnoreCase) < 0)
                        continue;

                    if (typeName.IndexOf("Palette", StringComparison.OrdinalIgnoreCase) >= 0) DumpPalette(asset);
                    int before = changed;
                    try { ConvertObject(asset, 0, ref changed); } catch { }
                    if (changed > before && touchedTypes.IndexOf(typeName, StringComparison.Ordinal) < 0)
                        touchedTypes += typeName + " ";
                }
            }
            catch (Exception error) { BrandingPlugin.Trace.LogWarning("palette : " + error.Message); }
            if (changed > 0)
                BrandingPlugin.Trace.LogInfo("palette : " + changed + " couleur(s) convertie(s) en bleu [" + touchedTypes.Trim() + "]");
        }

        // Une passe complete enumerait tous les Graphic/Selectable dans une seule frame :
        // c'est la chute de fps ressentie. On etale le meme travail sur plusieurs frames,
        // 2 ms maximum par frame, et on relance des qu'un clic reconstruit le theme.
        private Graphic[] paintGraphics = new Graphic[0];
        private Selectable[] paintSelectables = new Selectable[0];
        private int paintIndex;
        private float paintUntil;
        private int slicedChanged;
        private int slicedCanvas;
        // Temoins : elements deja passes en bleu. S'ils redeviennent orange, c'est que le
        // jeu a reconstruit son theme (au clic) : on repeint tout de suite, sans attendre
        // la passe de securite. Input n'est pas reference dans ce projet, ce signal le
        // remplace et ne coute que quelques lectures de propriete.
        private readonly List<Graphic> canaries = new List<Graphic>();
        // Textes mis de cote : ils passent avant le balayage complet.
        private readonly List<Graphic> textGraphics = new List<Graphic>();
        private int textIndex;
        // Boutons : le jeu remet son ColorBlock de base au clic, ce qui rend l'orange. On les
        // suit individuellement pour les reconvertir immediatement, sans attendre une passe.
        private readonly List<Selectable> selectableCanaries = new List<Selectable>();
        private float nextCanaryCheck;
        private float nextButtonFixLog;
        private GameObject lastSelected;

        // ------------------------------------------------------------- sonde montre
        // RECBLUE_DUMP.txt : releve les objets orange (chemin, type, sprite, texture) et
        // horodate chaque gel de frame en disant ce que le plugin faisait juste avant.
        // Sert a savoir qui dessine le bandeau orange de la montre et d'ou vient le gel.
        private const string DumpMarker = "C:/RecRoom2023/BepInEx/plugins/RECBLUE_DUMP.txt";
        private float nextDumpCheck;
        private float nextDumpAt;
        private int dumpRuns;
        private int enqueueRuns;
        private int spikeLogs;
        private bool frameBlit;
        private bool frameEnqueue;
        private bool frameRefresh;
        private bool frameSweep;
        private int deepSweeps;
        // Negatif : la toute premiere passe doit partir au demarrage, quand le logo du
        // chargement existe encore. Les suivantes respectent le plancher de 8 s.
        private float lastSweepAt = -30f;
        private bool titleSwapped;

        private string FrameWork()
        {
            // Les drapeaux decrivent la frame precedente : c'est elle qui a rallonge le delai
            // mesure par Time.unscaledDeltaTime.
            string work = "";
            if (frameBlit) work += "blit texture";
            if (frameEnqueue) work += (work.Length > 0 ? " + " : "") + "enumeration Image";
            if (frameRefresh) work += (work.Length > 0 ? " + " : "") + "refresh Graphic";
            if (frameSweep) work += (work.Length > 0 ? " + " : "") + "sweep sprites";
            return work.Length == 0 ? "aucun travail du plugin" : work;
        }

        private static string PathOf(Transform start)
        {
            string path = "";
            Transform current = start;
            int guard = 0;
            try
            {
                while (current != null && guard++ < 8)
                {
                    string name;
                    try { name = current.name; } catch { break; }
                    path = name + (path.Length > 0 ? "/" + path : "");
                    try { current = current.parent; } catch { break; }
                }
            }
            catch { }
            return path;
        }

        private void DumpOrangeOnce()
        {
            int total = 0;
            try
            {
                Canvas[] canvases = Resources.FindObjectsOfTypeAll<Canvas>();
                total = canvases.Length;
                int shown = 0;
                foreach (Canvas canvas in canvases)
                {
                    if (canvas == null || !canvas.isActiveAndEnabled) continue;
                    if (shown++ >= 12) break;
                }
            }
            catch { }

            int found = 0;
            try
            {
                Graphic[] graphics = Resources.FindObjectsOfTypeAll<Graphic>();
                foreach (Graphic graphic in graphics)
                {
                    if (graphic == null || !graphic.isActiveAndEnabled) continue;
                    Color color;
                    try { color = graphic.color; } catch { continue; }
                    if (!IsRecOrange(color)) continue;

                    string extra = "";
                    Image image = graphic as Image;
                    if (image != null)
                    {
                        Sprite sprite = null;
                        try { sprite = image.sprite; } catch { }
                        if (sprite != null)
                        {
                            Texture2D texture = null;
                            try { texture = sprite.texture; } catch { }
                            extra = " | sprite=" + (sprite.name ?? "?") + (texture != null ? " tex=" + texture.width + "x" + texture.height : "");
                        }
                        else extra = " | sans sprite (a plat)";
                    }
                    else
                    {
                        Text label = graphic as Text;
                        if (label != null) extra = " | texte=\"" + (label.text ?? "") + "\"";
                        else extra = " | " + graphic.GetType().Name + " sans sprite";
                    }
                    if (++found >= 40) break;
                }
            }
            catch { }

            // Textes : contenu et couleur reels. Sert a verifier que les titres de pieces
            // sont bien des composants texte et a voir la couleur qu'ils portent.
            int texts = 0;
            try
            {
                Text[] labels = Resources.FindObjectsOfTypeAll<Text>();
                foreach (Text label in labels)
                {
                    if (label == null || !label.isActiveAndEnabled) continue;
                    string content = "";
                    try { content = label.text ?? ""; } catch { }
                    Color color = Color.white;
                    try { color = label.color; } catch { }
                    if (++texts >= 200) break;
                }
                TMPro.TextMeshProUGUI[] tmps = Resources.FindObjectsOfTypeAll<TMPro.TextMeshProUGUI>();
                int tmpCount = 0;
                foreach (TMPro.TextMeshProUGUI tmp in tmps)
                {
                    if (tmp == null || !tmp.isActiveAndEnabled) continue;
                    string content = "";
                    try { content = tmp.text ?? ""; } catch { }
                    Color color = Color.white;
                    try { color = tmp.color; } catch { }
                    if (++tmpCount >= 400) break;
                }
            }
            catch (Exception error) { BrandingPlugin.Trace.LogInfo("sonde textes : " + error.Message); }

            // Un bandeau orange n'est pas forcement un Graphic orange : c'est souvent une
            // Image au teint blanc qui affiche une planche orange. On liste donc les Image
            // actives avec leur sprite, pour retrouver celle de la montre.
            int listed = 0;
            try
            {
                Image[] images = Resources.FindObjectsOfTypeAll<Image>();
                foreach (Image image in images)
                {
                    if (image == null || !image.isActiveAndEnabled) continue;
                    Sprite sprite = null;
                    try { sprite = image.sprite; } catch { }
                    if (sprite == null) continue;
                    Texture2D texture = null;
                    try { texture = sprite.texture; } catch { }
                    Color tint = Color.white;
                    try { tint = image.color; } catch { }
                    if (++listed >= 80) break;
                }
            }
            catch { }
        }

        // Le clic sur un bouton reconstruit ses couleurs de base. La selection d'UI est le
        // seul signal fiable disponible (Input n'est pas reference) : des qu'elle change,
        // on relance une repeinte immediate au lieu d'attendre la passe suivante.
        private void CheckSelection()
        {
            if (safeMode) return;
            try
            {
                UnityEngine.EventSystems.EventSystem system = UnityEngine.EventSystems.EventSystem.current;
                if (system == null) return;
                GameObject current = system.currentSelectedGameObject;
                if (current == lastSelected) return;
                lastSelected = current;
                if (current == null) return;
                paintIndex = 0;
                nextPassAt = 0f;
                paintUntil = 0f;
                RequestPaint(3f);
            }
            catch { }
        }
        private float nextPassAt;
        private float nextGraphicsRefresh;
        private float nextPaletteAt;
        private bool idleFlagRead;
        private bool idleForced;
        private bool idleLogged;
        // Un blit de texture trop lent bloque une frame entiere : apres un tel blit on
        // met la conversion en pause, sinon le jeu gele par vagues.
        private float texturePauseUntil;

        private void CheckCanaries(float now)
        {
            if (safeMode) return;
            if (now < nextCanaryCheck) return;
            // 80 ms : le theme RRUI remet ses couleurs tres vite apres un clic ; a 250 ms
            // l'utilisateur voyait l'orange revenir avant chaque correction.
            nextCanaryCheck = now + 0.5f;

            // 1) Boutons suivis : reconversion immediate du ColorBlock.
            int fixedButtons = 0;
            for (int i = 0; i < selectableCanaries.Count; i++)
            {
                Selectable selectable = selectableCanaries[i];
                if (selectable == null) continue;
                try
                {
                    ColorBlock block = selectable.colors;
                    bool touched = false;
                    if (IsRecOrange(block.normalColor)) { block.normalColor = ToRecBlue(block.normalColor); touched = true; }
                    if (IsRecOrange(block.highlightedColor)) { block.highlightedColor = ToRecBlue(block.highlightedColor); touched = true; }
                    if (IsRecOrange(block.pressedColor)) { block.pressedColor = ToRecBlue(block.pressedColor); touched = true; }
                    if (IsRecOrange(block.selectedColor)) { block.selectedColor = ToRecBlue(block.selectedColor); touched = true; }
                    if (IsRecOrange(block.disabledColor)) { block.disabledColor = ToRecBlue(block.disabledColor); touched = true; }
                    if (!touched) continue;
                    selectable.colors = block;
                    fixedButtons++;
                }
                catch { }
            }
            if (fixedButtons > 0 && now >= nextButtonFixLog)
            {
                nextButtonFixLog = now + 5f;
            }

            // 2) Images suivies : meme logique, sans ColorBlock.
            bool reverted = false;
            for (int i = 0; i < canaries.Count; i++)
            {
                Graphic canary = canaries[i];
                if (canary == null) continue;
                try
                {
                    if (IsRecOrange(canary.color)) { canary.color = ToRecBlue(canary.color); reverted = true; }
                }
                catch { }
            }
            // Le jeu reconstruit parfois son logo juste apres l'avoir affiche : on le remet
            // en place toutes les 120 ms, sinon l'orange revient entre deux balayages.
            for (int i = 0; i < logoCanaries.Count; i++)
            {
                Image logo = logoCanaries[i];
                if (logo == null) continue;
                try
                {
                    if (IsLoadingLogoPath(PathOf(logo.transform, 8))) continue;
                    if (logo.sprite != titleSprite)
                    {
                        logo.sprite = titleSprite;
                        logo.preserveAspect = true;
                        reverted = true;
                    }
                    // Le jeu remet parfois son echelle d'origine : on la reimpose ici.
                    EnlargeLoginLogo(logo);
                }
                catch { }
            }
            for (int i = 0; i < shadowCanaries.Count; i++)
            {
                Image shadow = shadowCanaries[i];
                if (shadow == null) continue;
                try { if (shadow.enabled) shadow.enabled = false; } catch { }
            }
            if (!reverted && fixedButtons == 0) return;
            RequestPaint(2f);
        }

        private void RequestPaint(float seconds)
        {
            float until = Time.realtimeSinceStartup + seconds;
            if (until > paintUntil) paintUntil = until;
        }

        // Seuls elements autorises a passer en bleu : les textes et, si le mode le permet,
        // les panneaux (fond de montre, tableaux, cartes). Boutons et icones restent au jeu.

        // Consigne : le bleu ne reste QUE sur le texte — titres de pieces, noms d'objets,
        // textes du MakerPen. Plus aucun fond, bouton ni icone, sauf la palette ciblee
        // des tuiles du Watch (TintWatchMenu ci-dessous), qui ne touche ni la main ni
        // le panneau de la montre.
        // La montre et les mains appartiennent au rendu du jeu : aucune passe generale
        // de couleur ne doit les modifier, sinon l'overlay de la montre peut masquer la main.
        private static bool IsWatchOrHandUi(Transform start)
        {
            try
            {
                string path = PathOf(start, 10).ToLowerInvariant();
                return path.Contains("watch") || path.Contains("wrist")
                    || path.Contains("hand") || path.Contains("avatar");
            }
            catch { return false; }
        }

        // Les fonds des tuiles du Watch gardent leurs couleurs d'origine. Seul le
        // grand aplat du panneau est rendu transparent.
        private static readonly HashSet<string> WatchTileKeys = new HashSet<string>
        {
            "play", "events", "create", "thisroom", "people", "messages",
            "challenges", "backpack", "clubs", "store", "dormroom", "reccenter", "visitall"
        };

        private float nextWatchTintAt;
        private bool watchPanelHidden;
        private bool watchDiagLogged;
        // Test uniquement : present uniquement si RECBLUE_AUTOLOGIN.txt existe.
        private const string AutoLoginMarker = "C:/RecRoom2023/BepInEx/plugins/RECBLUE_AUTOLOGIN.txt";
        private float nextAutoLoginAt;
        private bool autoLoginDone;
        private bool autoLoginMissingLogged;
        private bool autoLoginRaycastDone;

        // Recupere le libelle d'une tuile, en gerant Text classique et TextMeshPro.
        private static string WatchLabel(Selectable button)
        {
            try
            {
                Text text = button.GetComponentInChildren<Text>(true);
                if (text != null && !string.IsNullOrEmpty(text.text)) return text.text;
            }
            catch { }
            try
            {
                Component[] parts = button.GetComponentsInChildren<Component>(true);
                foreach (Component part in parts)
                {
                    if (part == null) continue;
                    string typeName = part.GetType().Name;
                    if (typeName.IndexOf("TextMeshPro", StringComparison.Ordinal) < 0
                        && typeName.IndexOf("TMP_", StringComparison.Ordinal) < 0) continue;
                    PropertyInfo property = part.GetType().GetProperty("text");
                    if (property == null) continue;
                    string value = property.GetValue(part, null) as string;
                    if (!string.IsNullOrEmpty(value)) return value;
                }
            }
            catch { }
            return null;
        }

        private static string WatchKey(string label)
        {
            if (string.IsNullOrEmpty(label)) return "";
            return label.Trim().TrimStart('^', '*').ToLowerInvariant().Replace(" ", "");
        }

        // Le fond de tuile est le plus grand Image du bouton, hors texte/icone.
        private static Graphic WatchTileBackground(Selectable button)
        {
            Graphic target = null;
            try { target = button.targetGraphic; } catch { }
            if (IsWatchTileGraphic(target)) return target;
            Graphic best = null;
            float bestArea = 0f;
            try
            {
                Graphic[] graphics = button.GetComponentsInChildren<Graphic>(true);
                foreach (Graphic graphic in graphics)
                {
                    if (!IsWatchTileGraphic(graphic)) continue;
                    Rect box = graphic.rectTransform.rect;
                    float area = box.width * box.height;
                    if (area > bestArea)
                    {
                        bestArea = area;
                        best = graphic;
                    }
                }
            }
            catch { }
            return best;
        }

        private static bool IsWatchTileGraphic(Graphic graphic)
        {
            if (graphic == null) return false;
            if (!(graphic is Image) && !(graphic is RawImage)) return false;
            try
            {
                Rect box = graphic.rectTransform.rect;
                return box.width >= 64f && box.height >= 64f;
            }
            catch { return false; }
        }

        // Certaines tuiles du Watch ne sont pas des Button/Selectable Unity :
        // on part cette fois du libelle rendu, puis on cherche l'aplat de la tuile
        // qui contient ce libelle. Cela evite de dependre du type de composant du bouton.
        private static Graphic WatchTileBackground(Transform label)
        {
            Transform current = label;
            for (int depth = 0; depth < 6 && current != null; depth++)
            {
                Graphic found = FindTileBackgroundIn(current, label);
                if (found != null) return found;
                current = current.parent;
            }
            return null;
        }

        private static Graphic FindTileBackgroundIn(Transform root, Transform label)
        {
            Graphic best = null;
            float bestArea = 0f;
            ConsiderTileBackgrounds(root, 2, label, ref best, ref bestArea);
            return best;
        }

        private static void ConsiderTileBackgrounds(Transform node, int depth, Transform label,
            ref Graphic best, ref float bestArea)
        {
            if (node == null || depth < 0) return;
            if (node == label || node.IsChildOf(label)) return;
            if (!node.gameObject.activeInHierarchy) return;
            try
            {
                Graphic graphic = node.GetComponent<Graphic>();
                if (graphic is Image || graphic is RawImage)
                {
                    Rect box = graphic.rectTransform.rect;
                    float width = Math.Abs(box.width);
                    float height = Math.Abs(box.height);
                    float area = width * height;
                    float small = Math.Min(width, height);
                    float large = Math.Max(width, height);
                    if (area >= 4096f && area <= 90000f && small > 0f && large / small <= 2.4f)
                    {
                        Vector3 local = graphic.rectTransform.InverseTransformPoint(label.position);
                        if (local.x >= box.xMin && local.x <= box.xMax
                            && local.y >= box.yMin && local.y <= box.yMax
                            && area > bestArea)
                        {
                            bestArea = area;
                            best = graphic;
                        }
                    }
                }
            }
            catch { }
            if (depth == 0) return;
            try
            {
                for (int i = 0; i < node.childCount; i++)
                    ConsiderTileBackgrounds(node.GetChild(i), depth - 1, label, ref best, ref bestArea);
            }
            catch { }
        }

        // Test de mesure : le client ne recoit pas le clic synthétique au login.
        // Ce chemin appelle directement onClick du bouton JOUER, uniquement quand
        // le marqueur RECBLUE_AUTOLOGIN.txt est present. Il est retire apres le test.
        private void AutoLoginForTest()
        {
            if (autoLoginDone || safeMode) return;
            float now = Time.realtimeSinceStartup;
            if (now < nextAutoLoginAt) return;
            nextAutoLoginAt = now + 2f;
            try { if (!File.Exists(AutoLoginMarker)) return; } catch { return; }
            try
            {
                Button[] buttons = FindObjectsOfType<Button>();
                foreach (Button button in buttons)
                {
                    if (button == null || !button.isActiveAndEnabled) continue;
                    string label = WatchLabel(button);
                    if (string.IsNullOrEmpty(label) || !label.Trim().Equals("JOUER", StringComparison.OrdinalIgnoreCase)) continue;
                    BrandingPlugin.Trace.LogInfo("autotest : bouton JOUER trouve, clic Unity");
                    button.onClick.Invoke();
                    autoLoginDone = true;
                    return;
                }
                if (!autoLoginMissingLogged)
                {
                    autoLoginMissingLogged = true;
                    BrandingPlugin.Trace.LogWarning("autotest : bouton JOUER introuvable");
                }
                if (!autoLoginRaycastDone)
                {
                    autoLoginRaycastDone = true;
                    TryClickLoginLabel();
                    if (!autoLoginDone) TryClickLoginByRaycast();
                }
            }
            catch (Exception error)
            {
                BrandingPlugin.Trace.LogWarning("autotest : login impossible (" + error.Message + ")");
            }
        }

        private static string GraphicText(Graphic graphic)
        {
            try
            {
                Text text = graphic as Text;
                if (text != null) return text.text;
            }
            catch { }
            try
            {
                TMP_Text tmp = graphic.GetComponent<TMP_Text>();
                if (tmp != null && !string.IsNullOrEmpty(tmp.text)) return tmp.text;
            }
            catch { }
            try
            {
                Component[] parts = graphic.GetComponents<Component>();
                foreach (Component part in parts)
                {
                    if (part == null) continue;
                    string typeName = part.GetType().Name;
                    if (typeName.IndexOf("TextMeshPro", StringComparison.Ordinal) < 0
                        && typeName.IndexOf("TMP_", StringComparison.Ordinal) < 0) continue;
                    PropertyInfo property = part.GetType().GetProperty("text");
                    if (property == null) continue;
                    string value = property.GetValue(part, null) as string;
                    if (!string.IsNullOrEmpty(value)) return value;
                }
            }
            catch { }
            return null;
        }

        // Dernier recours : le libelle JOUER est un Graphic dont un parent porte le
        // handler de clic. On declenche le handler sans dependre du raycast.
        private void TryClickLoginLabel()
        {
            try
            {
                UnityEngine.EventSystems.EventSystem events = UnityEngine.EventSystems.EventSystem.current;
                if (events == null) return;
                Graphic[] graphics = FindObjectsOfType<Graphic>();
                foreach (Graphic graphic in graphics)
                {
                    if (graphic == null || !graphic.isActiveAndEnabled) continue;
                    string label = GraphicText(graphic);
                    if (string.IsNullOrEmpty(label) || !label.Trim().Equals("JOUER", StringComparison.OrdinalIgnoreCase)) continue;
                    string path = "";
                    try { path = PathOf(graphic.transform, 8); } catch { }
                    BrandingPlugin.Trace.LogInfo("autotest : texte JOUER " + path);
                    UnityEngine.GameObject handler = UnityEngine.EventSystems.ExecuteEvents.GetEventHandler<UnityEngine.EventSystems.IPointerClickHandler>(graphic.gameObject);
                    if (handler == null)
                    {
                        BrandingPlugin.Trace.LogWarning("autotest : handler JOUER introuvable");
                        return;
                    }
                    UnityEngine.EventSystems.PointerEventData pointer = new UnityEngine.EventSystems.PointerEventData(events);
                    pointer.position = new Vector2(Screen.width * 0.716f, Screen.height * 0.604f);
                    pointer.button = UnityEngine.EventSystems.PointerEventData.InputButton.Left;
                    UnityEngine.EventSystems.ExecuteEvents.Execute<UnityEngine.EventSystems.IPointerDownHandler>(handler, pointer, UnityEngine.EventSystems.ExecuteEvents.pointerDownHandler);
                    UnityEngine.EventSystems.ExecuteEvents.Execute<UnityEngine.EventSystems.IPointerUpHandler>(handler, pointer, UnityEngine.EventSystems.ExecuteEvents.pointerUpHandler);
                    UnityEngine.EventSystems.ExecuteEvents.Execute<UnityEngine.EventSystems.IPointerClickHandler>(handler, pointer, UnityEngine.EventSystems.ExecuteEvents.pointerClickHandler);
                    autoLoginDone = true;
                    BrandingPlugin.Trace.LogInfo("autotest : clic sur handler " + PathOf(handler.transform, 6));
                    return;
                }
            }
            catch (Exception error)
            {
                BrandingPlugin.Trace.LogWarning("autotest : label JOUER impossible (" + error.Message + ")");
            }
        }

        // Le bouton JOUER n'est pas un Button Unity : on passe par le GraphicRaycaster
        // de l'EventSystem, a la position mesuree sur la capture du login.
        private void TryClickLoginByRaycast()
        {
            try
            {
                UnityEngine.EventSystems.EventSystem events = UnityEngine.EventSystems.EventSystem.current;
                if (events == null)
                {
                    BrandingPlugin.Trace.LogWarning("autotest : EventSystem absent");
                    return;
                }
                UnityEngine.EventSystems.PointerEventData pointer = new UnityEngine.EventSystems.PointerEventData(events);
                pointer.position = new Vector2(Screen.width * 0.716f, Screen.height * 0.604f);
                pointer.button = UnityEngine.EventSystems.PointerEventData.InputButton.Left;
                Il2CppSystem.Collections.Generic.List<UnityEngine.EventSystems.RaycastResult> hits =
                    new Il2CppSystem.Collections.Generic.List<UnityEngine.EventSystems.RaycastResult>();
                events.RaycastAll(pointer, hits);
                if (hits.Count == 0)
                {
                    BrandingPlugin.Trace.LogWarning("autotest : raycast login vide a " + pointer.position);
                    return;
                }
                for (int i = 0; i < hits.Count; i++)
                {
                    UnityEngine.GameObject target = hits[i].gameObject;
                    if (target == null) continue;
                    string path = "";
                    try { path = PathOf(target.transform, 6); } catch { }
                    BrandingPlugin.Trace.LogInfo("autotest : raycast click " + path);
                    UnityEngine.EventSystems.ExecuteEvents.Execute<UnityEngine.EventSystems.IPointerClickHandler>(
                        target, pointer, UnityEngine.EventSystems.ExecuteEvents.pointerClickHandler);
                    autoLoginDone = true;
                    return;
                }
            }
            catch (Exception error)
            {
                BrandingPlugin.Trace.LogWarning("autotest : raycast impossible (" + error.Message + ")");
            }
        }

        // Passe separee et volontairement limitee au panneau du Watch : les tuiles,
        // les textes et les mains gardent leurs couleurs d'origine.
        private void TintWatchMenu(float now)
        {
            if (!BrandingPlugin.EnableWatchTransparency || now < nextWatchTintAt) return;
            nextWatchTintAt = now + 1f;
            List<Graphic> labels = new List<Graphic>();
            try
            {
                TMP_Text[] tmps = FindObjectsOfType<TMP_Text>();
                foreach (TMP_Text tmp in tmps)
                {
                    if (tmp == null || !tmp.isActiveAndEnabled || string.IsNullOrEmpty(tmp.text)) continue;
                    labels.Add(tmp);
                }
            }
            catch { }
            try
            {
                Text[] texts = FindObjectsOfType<Text>();
                foreach (Text text in texts)
                {
                    if (text == null || !text.isActiveAndEnabled || string.IsNullOrEmpty(text.text)) continue;
                    if (!labels.Contains(text)) labels.Add(text);
                }
            }
            catch { }
            if (labels.Count == 0)
            {
                try { labels.AddRange(FindObjectsOfType<Graphic>()); } catch { return; }
            }
            List<Graphic> anchors = new List<Graphic>();
            List<Graphic> backgrounds = new List<Graphic>();
            bool hasThisRoom = false;
            int selectableMatches = 0;

            // Certaines tuiles ne sont pas des Selectable Unity ; on commence par les
            // boutons, puis on complete avec le chemin par libelle. Les deux chemins
            // remplissent la meme liste, sans jamais colorer les tuiles.
            try
            {
                Selectable[] selectables = FindObjectsOfType<Selectable>();
                foreach (Selectable selectable in selectables)
                {
                    if (selectable == null || !selectable.isActiveAndEnabled) continue;
                    string key = WatchKey(WatchLabel(selectable));
                    if (!WatchTileKeys.Contains(key)) continue;
                    selectableMatches++;
                    if (key == "thisroom") hasThisRoom = true;
                    Graphic background = WatchTileBackground(selectable);
                    if (background == null || backgrounds.Contains(background)) continue;
                    backgrounds.Add(background);
                }
            }
            catch { }

            foreach (Graphic graphic in labels)
            {
                if (graphic == null || !graphic.isActiveAndEnabled) continue;
                string label = GraphicText(graphic);
                string key = WatchKey(label);
                if (!WatchTileKeys.Contains(key)) continue;
                if (!anchors.Contains(graphic)) anchors.Add(graphic);
                if (key == "thisroom") hasThisRoom = true;
                Graphic background = WatchTileBackground(graphic.transform);
                if (background == null || backgrounds.Contains(background)) continue;
                backgrounds.Add(background);
            }
            // Un seul « This Room » et au moins quatre tuiles connues : on est bien
            // dans le Watch, pas dans un panneau qui réutilise un libellé isolé.
            if (!hasThisRoom || (backgrounds.Count < 4 && anchors.Count < 4))
            {
                if (!watchDiagLogged && anchors.Count > 0)
                {
                    watchDiagLogged = true;
                    BrandingPlugin.Trace.LogInfo("watch diag : labels=" + labels.Count + " ancres=" + anchors.Count
                        + " tuiles=" + backgrounds.Count + " thisRoom=" + hasThisRoom
                        + " selectables=" + selectableMatches);
                }
                return;
            }
            int hidden = 0;
            if (backgrounds.Count >= 4) hidden = MakeWatchPanelTransparent(backgrounds);
            // Si les fonds de tuiles n'ont pas ete retrouves, les libelles suffisent
            // a localiser le grand panneau qui les contient tous.
            if (hidden == 0) hidden = MakeWatchPanelTransparent(anchors);
            if (hidden > 0)
            {
                if (!watchPanelHidden)
                {
                    watchPanelHidden = true;
                    BrandingPlugin.Trace.LogInfo("watch : fond du panneau transparent (" + hidden + " image(s)).");
                }
            }
            else
            {
                // Le jeu peut reconstruire le panneau quand le Watch se ferme/reouvre.
                // On reautorise alors une nouvelle application au prochain passage.
                watchPanelHidden = false;
            }
        }

        // Le panneau du Watch est un grand aplat derriere la grille. On ne peut pas
        // le confondre avec une tuile : il doit contenir le centre de toutes les tuiles.
        private static int MakeWatchPanelTransparent(List<Graphic> tiles)
        {
            Transform common = CommonAncestor(tiles);
            if (common == null) return 0;
            float maxWidth = 0f;
            float maxHeight = 0f;
            float maxArea = 0f;
            foreach (Graphic tile in tiles)
            {
                if (tile == null) continue;
                try
                {
                    Rect box = tile.rectTransform.rect;
                    float width = Math.Abs(box.width);
                    float height = Math.Abs(box.height);
                    maxWidth = Math.Max(maxWidth, width);
                    maxHeight = Math.Max(maxHeight, height);
                    maxArea = Math.Max(maxArea, width * height);
                }
                catch { }
            }
            float minWidth = maxWidth * 1.5f;
            float minHeight = maxHeight * 1.5f;
            float minArea = Math.Max(60000f, maxArea * 2f);
            Transform current = common;
            for (int level = 0; level < 7 && current != null; level++)
            {
                List<Graphic> candidates = new List<Graphic>();
                CollectPanelImages(current, 2, tiles, minWidth, minHeight, minArea, candidates);
                if (candidates.Count > 0)
                {
                    int hidden = 0;
                    foreach (Graphic image in candidates)
                    {
                        if (image == null) continue;
                        try
                        {
                            Color color = image.color;
                            if (color.a > 0.001f)
                            {
                                color.a = 0f;
                                image.color = color;
                                image.canvasRenderer.SetAlpha(0f);
                            }
                            hidden++;
                        }
                        catch { }
                    }
                    return hidden;
                }
                current = current.parent;
            }
            return 0;
        }

        private static Transform CommonAncestor(List<Graphic> items)
        {
            if (items == null || items.Count == 0) return null;
            Transform current = items[0] == null ? null : items[0].transform;
            while (current != null)
            {
                bool containsAll = true;
                foreach (Graphic item in items)
                {
                    if (item == null) continue;
                    if (item.transform != current && !item.transform.IsChildOf(current))
                    {
                        containsAll = false;
                        break;
                    }
                }
                if (containsAll) return current;
                current = current.parent;
            }
            return null;
        }

        private static void CollectPanelImages(Transform node, int depth, List<Graphic> tiles,
            float minWidth, float minHeight, float minArea, List<Graphic> found)
        {
            if (node == null || depth < 0) return;
            if (!node.gameObject.activeInHierarchy) return;
            Graphic graphic = null;
            try { graphic = node.GetComponent<Graphic>(); } catch { }
            if ((graphic is Image || graphic is RawImage) && !tiles.Contains(graphic))
            {
                try
                {
                    Rect box = graphic.rectTransform.rect;
                    float width = Math.Abs(box.width);
                    float height = Math.Abs(box.height);
                    if (width >= minWidth && height >= minHeight && width * height >= minArea
                        && ContainsAllTileCenters(graphic.rectTransform, tiles))
                        found.Add(graphic);
                }
                catch { }
            }
            if (depth == 0) return;
            try
            {
                for (int i = 0; i < node.childCount; i++)
                    CollectPanelImages(node.GetChild(i), depth - 1, tiles, minWidth, minHeight, minArea, found);
            }
            catch { }
        }

        private static bool ContainsAllTileCenters(RectTransform panel, List<Graphic> tiles)
        {
            try
            {
                Rect box = panel.rect;
                foreach (Graphic tile in tiles)
                {
                    if (tile == null) return false;
                    Vector3 local = panel.InverseTransformPoint(tile.rectTransform.position);
                    if (local.x < box.xMin || local.x > box.xMax
                        || local.y < box.yMin || local.y > box.yMax) return false;
                }
                return true;
            }
            catch { return false; }
        }

        private static bool IsKept(Graphic graphic)
        {
            if (graphic == null || IsWatchOrHandUi(graphic.transform)) return false;
            if (graphic is Text) return true;
            string type = graphic.GetType().Name;
            if (type.StartsWith("TextMeshPro", StringComparison.Ordinal) || type.IndexOf("TMP_", StringComparison.Ordinal) >= 0) return true;
            return IsBoard(graphic.transform);
        }

        // Le tableau de la chambre : tout ce qui vit sous un ancetre CommunityBoard.
        private static bool IsBoard(Transform start)
        {
            Transform current = start;
            int guard = 0;
            while (current != null && guard++ < 24)
            {
                string name = current.name ?? "";
                if (name.IndexOf("CommunityBoard", StringComparison.OrdinalIgnoreCase) >= 0) return true;
                if (name.IndexOf("tableau", StringComparison.OrdinalIgnoreCase) >= 0) return true;
                current = current.parent;
            }
            return false;
        }

        // Textes 3D du MakerPen : TextMesh n'est pas un Graphic, il a sa propre couleur.
        private void PaintTextMeshes()
        {
            if (!BrandingPlugin.EnableBlueUi) return;
            try
            {
                TextMesh[] meshes = UnityEngine.Object.FindObjectsOfType<TextMesh>();
                int painted = 0;
                foreach (TextMesh mesh in meshes)
                {
                    if (mesh == null || IsWatchOrHandUi(mesh.transform)) continue;
                    Color color;
                    try { color = mesh.color; } catch { continue; }
                    if (!IsRecOrange(color)) continue;
                    try { mesh.color = ToRecBlue(color); painted++; } catch { }
                }
                if (painted > 0) BrandingPlugin.Trace.LogInfo("textes 3D : " + painted + " element(s) en bleu.");
            }
            catch { }
        }

        private void PaintSlice()
        {
            if (safeMode || !BrandingPlugin.EnableBlueUi) return;
            float now = Time.realtimeSinceStartup;
            if (now > paintUntil || now < nextPassAt) return;
            System.Diagnostics.Stopwatch watch = System.Diagnostics.Stopwatch.StartNew();
            int changed = 0;
            int canvasChanged = 0;
            // Re-enumerer tous les Graphic a chaque passe coutait le framerate (12 fps
            // mesure) : on garde la liste 2 s et on n'enchainne pas les passes.
            // L'enumeration complete des Graphic a ete mesuree a 2,3 s de gel (sonde) : on
            // ne la lance plus que sur une frame saine, et deux fois moins souvent.
            if (paintIndex == 0 && now >= nextGraphicsRefresh && Time.unscaledDeltaTime < 0.03f)
            {
                // 8 s donnaient un pic de 23 ms toutes les 8 s dans le journal. On espace
                // la passe de securite ; un nouveau canvas la force immediatement ci-dessous.
                nextGraphicsRefresh = now + 20f;
                frameRefresh = true;
                // Objets actifs uniquement : Resources.FindObjectsOfTypeAll parcourt aussi tous
                // les gabarits charges en memoire et a ete mesure a 2,3 s de gel.
                System.Diagnostics.Stopwatch scan = System.Diagnostics.Stopwatch.StartNew();
                try { paintGraphics = UnityEngine.Object.FindObjectsOfType<Graphic>(); } catch { paintGraphics = new Graphic[0]; }
                if (scan.ElapsedMilliseconds >= 20)
                    BrandingPlugin.Trace.LogInfo("perf : enumeration graphic " + scan.ElapsedMilliseconds + " ms (" + paintGraphics.Length + " objets)");
                // On isole les textes une fois pour toutes : ils sont peu nombreux et ce sont
                // eux que l'on veut bleus.
                textGraphics.Clear();
                textIndex = 0;
                for (int i = 0; i < paintGraphics.Length; i++)
                {
                    Graphic candidate = paintGraphics[i];
                    if (candidate != null && IsKept(candidate)) textGraphics.Add(candidate);
                }
                // Boutons laisses au jeu (consigne : textes et panneaux seulement).
                paintSelectables = new Selectable[0];
            }
            // Priorite aux textes : le balayage complet parcourt des milliers de Graphic et
            // les titres de pieces restaient rouges en attendant leur tour.
            while (textIndex < textGraphics.Count)
            {
                if (watch.Elapsed.TotalMilliseconds > 0.30) break;
                Graphic text = textGraphics[textIndex++];
                if (text == null) continue;
                try
                {
                    Color current = text.color;
                    if (!IsRecOrange(current)) continue;
                    text.color = ToRecBlue(current);
                    changed++;
                    if (canaries.Count < 200 && !canaries.Contains(text)) canaries.Add(text);
                }
                catch { }
            }
            int total = paintGraphics.Length + paintSelectables.Length;
            while (paintIndex < total)
            {
                // 2 ms par frame coutait visiblement le framerate a 240 Hz : 0,5 ms suffit
                // pour finir une passe en une seconde sans jamais bloquer une frame.
                if (watch.Elapsed.TotalMilliseconds > 0.30) break;
                int index = paintIndex;
                if (index < paintGraphics.Length)
                {
                    Graphic graphic = paintGraphics[index];
                    if (graphic != null)
                    {
                        Color current;
                        try { current = graphic.color; } catch { current = Color.white; }
                        if (IsRecOrange(current) && IsKept(graphic))
                        {
                            try
                            {
                                graphic.color = ToRecBlue(current);
                                changed++;
                                if (canaries.Count < 200 && !canaries.Contains(graphic)) canaries.Add(graphic);
                            }
                            catch { }
                        }
                        try
                        {
                            CanvasRenderer renderer = graphic.canvasRenderer;
                            if (renderer != null && IsKept(graphic))
                            {
                                Color vertex = renderer.GetColor();
                                if (IsRecOrange(vertex))
                                {
                                    renderer.SetColor(ToRecBlue(vertex));
                                    canvasChanged++;
                                }
                            }
                        }
                        catch { }
                    }
                }
                else
                {
                    Selectable selectable = paintSelectables[index - paintGraphics.Length];
                    if (selectable != null)
                    {
                        bool haveBlock = true;
                        ColorBlock block = default(ColorBlock);
                        try { block = selectable.colors; } catch { haveBlock = false; }
                        if (haveBlock)
                        {
                            bool touched = false;
                            if (IsRecOrange(block.normalColor)) { block.normalColor = ToRecBlue(block.normalColor); touched = true; }
                            if (IsRecOrange(block.highlightedColor)) { block.highlightedColor = ToRecBlue(block.highlightedColor); touched = true; }
                            if (IsRecOrange(block.pressedColor)) { block.pressedColor = ToRecBlue(block.pressedColor); touched = true; }
                            if (IsRecOrange(block.selectedColor)) { block.selectedColor = ToRecBlue(block.selectedColor); touched = true; }
                            if (IsRecOrange(block.disabledColor)) { block.disabledColor = ToRecBlue(block.disabledColor); touched = true; }
                            if (touched)
                            {
                                try
                                {
                                    selectable.colors = block;
                                    changed++;
                                    if (selectableCanaries.Count < 400 && !selectableCanaries.Contains(selectable)) selectableCanaries.Add(selectable);
                                    Graphic target = null;
                                    try { target = selectable.image; } catch { }
                                    if (target != null && canaries.Count < 200 && !canaries.Contains(target)) canaries.Add(target);
                                }
                                catch { }
                            }
                        }
                    }
                }
                paintIndex++;
            }
            slicedChanged += changed;
            slicedCanvas += canvasChanged;
            if (paintIndex >= total)
            {
                paintIndex = 0;
                textIndex = 0;
                nextPassAt = now + 2f;
                PaintTextMeshes();
                if (slicedChanged > 0 || slicedCanvas > 0)
                    BrandingPlugin.Trace.LogInfo("teintes : " + slicedChanged + " element(s) passe(s) en bleu, " + slicedCanvas + " canvas (lisse).");
                slicedChanged = 0;
                slicedCanvas = 0;
            }
        }

        private void TintPass()
        {
            if (!BrandingPlugin.EnablePanelTinting || safeMode) return;
            int changed = 0;
            int canvasChanged = 0;

            try
            {
                Graphic[] graphics = Resources.FindObjectsOfTypeAll<Graphic>();
                foreach (Graphic graphic in graphics)
                {
                    if (graphic == null) continue;
                    Color current;
                    try { current = graphic.color; } catch { current = Color.white; }
                    if (IsRecOrange(current))
                    {
                        try { graphic.color = ToRecBlue(current); changed++; } catch { }
                    }

                    // La couleur reellement dessinee peut venir du CanvasRenderer (vertex color)
                    // et non de Graphic.color : c'est la que vivent les boutons RRUI.
                    try
                    {
                        CanvasRenderer renderer = graphic.canvasRenderer;
                        if (renderer == null) continue;
                        Color vertex = renderer.GetColor();
                        if (!IsRecOrange(vertex)) continue;
                        renderer.SetColor(ToRecBlue(vertex));
                        canvasChanged++;
                    }
                    catch { }
                }
            }
            catch { }


            try
            {
                Selectable[] selectables = UnityEngine.Object.FindObjectsOfType<Selectable>();
                foreach (Selectable selectable in selectables)
                {
                    if (selectable == null) continue;
                    ColorBlock block;
                    try { block = selectable.colors; } catch { continue; }
                    bool touched = false;
                    try
                    {
                        if (IsRecOrange(block.normalColor)) { block.normalColor = ToRecBlue(block.normalColor); touched = true; }
                        if (IsRecOrange(block.highlightedColor)) { block.highlightedColor = ToRecBlue(block.highlightedColor); touched = true; }
                        if (IsRecOrange(block.pressedColor)) { block.pressedColor = ToRecBlue(block.pressedColor); touched = true; }
                        if (IsRecOrange(block.selectedColor)) { block.selectedColor = ToRecBlue(block.selectedColor); touched = true; }
                        if (IsRecOrange(block.disabledColor)) { block.disabledColor = ToRecBlue(block.disabledColor); touched = true; }
                    }
                    catch { }
                    if (!touched) continue;
                    try { selectable.colors = block; changed++; } catch { }
                }
            }
            catch { }

            if (changed > 0) BrandingPlugin.Trace.LogInfo("teintes : " + changed + " element(s) passe(s) en bleu.");
        }

        // Seulement les grands fonds (panneaux), jamais les textes ni les boutons :
        // on exclut les Selectable et on garde une taille minimale de panneau.
        private static void TintBackgrounds()
        {
            if (!BrandingPlugin.EnablePanelTinting || safeMode) return;
            float now = Time.realtimeSinceStartup;
            if (now < 3f || now < nextPanelTintAt) return;
            nextPanelTintAt = now + 3f;
            int changed = 0;
            try
            {
                Graphic[] graphics = UnityEngine.Object.FindObjectsOfType<Graphic>();
                foreach (Graphic graphic in graphics)
                {
                    if (graphic == null) continue;
                    try { if (!graphic.isActiveAndEnabled) continue; } catch { continue; }
                    Image image = graphic as Image;
                    RawImage raw = graphic as RawImage;
                    if (image == null && raw == null) continue;
                    try { if (graphic.GetComponent<Selectable>() != null) continue; } catch { continue; }
                    // Hors du tableau d'accueil, rien n'est teinte : la passe globale ne
                    // sert qu'a rattraper les panneaux du tableau rates a l'activation.
                    if (!BrandingPlugin.EnablePanelTinting && !IsBoard(graphic.transform)) continue;
                    string path = "";
                    try { path = PathOf(graphic.transform, 8); } catch { }
                    string lower = path.ToLowerInvariant();
                    if (lower.Contains("loading") || lower.Contains("splash") || lower.Contains("bootui")) continue;
                    if (IsWatchOrHandUi(graphic.transform)) continue;
                    Rect box;
                    try { box = graphic.rectTransform.rect; } catch { continue; }
                    if (box.width < 250f || box.height < 110f) continue;
                    Color current;
                    try { current = graphic.color; } catch { continue; }
                    if (panelLogs < 12)
                    {
                        panelLogs++;
                        string sprite = "";
                        string tex = "";
                        try
                        {
                            if (image != null && image.sprite != null)
                            {
                                sprite = image.sprite.name ?? "";
                                if (image.sprite.texture != null) tex = image.sprite.texture.name ?? "";
                            }
                        }
                        catch { }
                        try { if (raw != null && raw.texture != null) tex = raw.texture.name ?? ""; } catch { }
                        BrandingPlugin.Trace.LogInfo("panneau image : " + path + " " + Mathf.RoundToInt(box.width) + "x" + Mathf.RoundToInt(box.height)
                            + " color=" + current + " sprite=" + sprite + " tex=" + tex);
                    }
                    bool lightPanel = IsLightPanel(current)
                        && !lower.Contains("avatar")
                        && !lower.Contains("icon")
                        && !lower.Contains("photo")
                        && !lower.Contains("thumbnail")
                        && !lower.Contains("video")
                        && !lower.Contains("scrollingbackground")
                        && !lower.Contains("rendertexture");
                    // Sur le tableau, le fond d'un panneau est teinte quelle que soit sa couleur de
                    // depart : ses panneaux sont violets et roses, pas orange, donc le test de
                    // couleur des panneaux du jeu les laissait intacts.
                    if (!IsPanelColour(current) && !lightPanel
                        && !(IsBoard(graphic.transform) && IsBoardBackground(graphic, lower))) continue;
                    try { graphic.color = IsBoard(graphic.transform) ? ToBoardBlue(current) : ToPanelBlue(current); changed++; } catch { }
                }
            }
            catch { }
            if (changed > 0) BrandingPlugin.Trace.LogInfo("panneaux : " + changed + " fond(s) passe(s) en bleu.");
        }

        internal static void TintBackgroundsForGraphic(Graphic graphic)
        {
            if ((!BrandingPlugin.EnablePanelTinting && !BrandingPlugin.EnableBoardTint) || safeMode || graphic == null) return;
            if (IsWatchOrHandUi(graphic.transform)) return;
            Image image = graphic as Image;
            RawImage raw = graphic as RawImage;
            if (image == null && raw == null) return;
            bool board = IsBoard(graphic.transform);
            if (!board && !BrandingPlugin.EnablePanelTinting) return;
            string path = "";
            try { path = PathOf(graphic.transform, 8); } catch { }
            string lower = path.ToLowerInvariant();
            if (lower.Contains("loading") || lower.Contains("splash") || lower.Contains("bootui")) return;
            Rect box;
            try { box = graphic.rectTransform.rect; } catch { return; }
            Color current;
            try { current = graphic.color; } catch { return; }
            if (panelSeenLogs < 30)
            {
                panelSeenLogs++;
                BrandingPlugin.Trace.LogInfo("panneau vu : " + path + " " + Mathf.RoundToInt(box.width) + "x" + Mathf.RoundToInt(box.height) + " " + current + " board=" + board);
            }
            float minWidth = board ? 40f : 180f;
            float minHeight = board ? 20f : 80f;
            if (box.width < minWidth || box.height < minHeight) return;
            bool lightPanel = IsLightPanel(current)
                && !lower.Contains("avatar")
                && !lower.Contains("icon")
                && !lower.Contains("photo")
                && !lower.Contains("thumbnail")
                && !lower.Contains("video")
                && !lower.Contains("scrollingbackground")
                && !lower.Contains("rendertexture");
            if (!IsPanelColour(current) && !lightPanel && !(board && IsBoardBackground(graphic, lower)))
                return;
            Color blue = board ? ToBoardBlue(current) : ToPanelBlue(current);
            try { graphic.color = blue; } catch { return; }
            if (panelLogs < 12)
            {
                panelLogs++;
                string extra = "";
                try
                {
                    if (image != null && image.sprite != null) extra = " sprite=" + (image.sprite.name ?? "");
                    if (raw != null && raw.texture != null) extra = " tex=" + (raw.texture.name ?? "");
                }
                catch { }
                BrandingPlugin.Trace.LogInfo("panneau image : " + path + " " + Mathf.RoundToInt(box.width) + "x" + Mathf.RoundToInt(box.height) + " " + current + " -> " + blue + extra);
            }
        }

        // Le fond d'un panneau du tableau : une image de sprite pleine, ou un RawImage opaque,
        // mais pas une photo miniature. C'est ce qui distingue « le panneau » de « ce qui est
        // affiche dessus » (vignettes de salle, de video, d'avatar).
        private static bool IsBoardBackground(Graphic graphic, string lowerPath)
        {
            if (lowerPath.Contains("thumbnail") || lowerPath.Contains("photo")
                || lowerPath.Contains("video") || lowerPath.Contains("avatar")
                || lowerPath.Contains("icon") || lowerPath.Contains("scrollingbackground")
                || lowerPath.Contains("rendertexture")) return false;
            Image image = graphic as Image;
            if (image != null) return image.sprite != null;
            RawImage raw = graphic as RawImage;
            if (raw != null) return raw.texture != null;
            return false;
        }

        private static bool IsWarmPixel(Color c)
        {
            return c.a > 0.1f && c.r > 0.25f && c.r > c.g * 1.05f
                && c.g > c.b * 0.9f && c.r - c.b > 0.05f;
        }

        private Texture2D RecolourBoardTexture(Texture2D src)
        {
            if (src == null) return null;
            int sw = src.width;
            int sh = src.height;
            if (sw < 16 || sh < 16) return null;
            int w = sw > 256 ? 256 : sw;
            int h = sh > 256 ? 256 : sh;
            RenderTexture rt = null;
            RenderTexture previous = RenderTexture.active;
            try
            {
                rt = RenderTexture.GetTemporary(w, h, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.Default);
                Graphics.Blit(src, rt);
                RenderTexture.active = rt;
                Texture2D copy = new Texture2D(w, h, TextureFormat.RGBA32, false);
                copy.ReadPixels(new Rect(0, 0, w, h), 0, 0);
                copy.Apply();
                RenderTexture.active = previous;
                Color32[] pixels = copy.GetPixels32();
                int hit = 0;
                for (int i = 0; i < pixels.Length; i++)
                {
                    Color32 c = pixels[i];
                    if (c.a < 26 || c.r < 64) continue;
                    if ((int)c.r * 100 < (int)c.g * 105) continue;
                    if ((int)c.g * 100 < (int)c.b * 90) continue;
                    if ((int)c.r - c.b <= 13) continue;
                    int v = Mathf.Max(c.r, Mathf.Max(c.g, c.b));
                    pixels[i] = new Color32(
                        (byte)Mathf.Min(255, 31 + (v * 76) / 255),
                        (byte)Mathf.Min(255, 89 + (v * 89) / 255),
                        255,
                        c.a);
                    hit++;
                }
                if (hit == 0)
                {
                    Destroy(copy);
                    BrandingPlugin.Trace.LogInfo("monde : tableau texture sans pixel chaud " + (src.name ?? ""));
                    return null;
                }
                copy.SetPixels32(pixels);
                copy.Apply();
                copy.name = (src.name ?? "board") + "_recblue";
                BrandingPlugin.Trace.LogInfo("monde : texture tableau " + (src.name ?? "") + " -> " + hit + " pixel(s)");
                return copy;
            }
            catch (Exception error)
            {
                BrandingPlugin.Trace.LogWarning("monde : recolor tableau " + error.Message);
                return null;
            }
            finally
            {
                RenderTexture.active = previous;
                if (rt != null) RenderTexture.ReleaseTemporary(rt);
            }
        }

        private void WorldBoardPass()
        {
            if (KeepOriginalBoard) return;
            try
            {
                if (boardMaterial == null)
                {
                    foreach (Renderer r in UnityEngine.Object.FindObjectsOfType<Renderer>())
                    {
                        if (r == null || !r.enabled) continue;
                        string path = PathOf(r.transform, 8);
                        string mn = "";
                        try { mn = r.sharedMaterial != null ? (r.sharedMaterial.name ?? "") : ""; } catch { }
                        if (path.IndexOf("DormRoom_BulletinBoard_mat", StringComparison.OrdinalIgnoreCase) < 0
                            && mn.IndexOf("DormRoom_BulletinBoard_mat", StringComparison.OrdinalIgnoreCase) < 0) continue;
                        try { boardMaterial = r.sharedMaterial; } catch { }
                        if (boardMaterial != null)
                        {
                            BrandingPlugin.Trace.LogInfo("monde : tableau trouve " + path + " mat=" + (boardMaterial.name ?? ""));
                            break;
                        }
                    }
                }
                if (boardMaterial == null) return;
                if (boardBlueTexture == null)
                {
                    Texture2D source = null;
                    try { source = boardMaterial.mainTexture as Texture2D; } catch { }
                    if (source == null)
                    {
                        foreach (Texture2D tex in Resources.FindObjectsOfTypeAll<Texture2D>())
                        {
                            if (tex == null) continue;
                            string n = tex.name ?? "";
                            if (n.IndexOf("_recblue", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                            if (n.IndexOf("DormRoom_BulletinBoard_tex", StringComparison.OrdinalIgnoreCase) < 0) continue;
                            source = tex;
                            break;
                        }
                    }
                    if (source != null)
                    {
                        string sn = source.name ?? "";
                        boardBlueTexture = sn.IndexOf("_recblue", StringComparison.OrdinalIgnoreCase) >= 0
                            ? source : RecolourBoardTexture(source);
                    }
                }
                if (boardBlueTexture == null) return;
                try { if (boardMaterial.mainTexture == boardBlueTexture) return; } catch { }
                boardMaterial.mainTexture = boardBlueTexture;
                if (boardMaterial.HasProperty("_MainTex")) boardMaterial.SetTexture("_MainTex", boardBlueTexture);
            }
            catch (Exception error) { BrandingPlugin.Trace.LogWarning("monde : " + error.Message); }
        }

        // Le tableau de la Dorm Room est peint par une texture (fond orange, cartes) :
        // on ne recolore que ses textures, une fois, sans toucher au reste de l'UI.
        private void RecolourBoardTextures()
        {
            if (KeepOriginalBoard) return;
            bool showDiag = !boardDiagShown;
            int seen = 0;
            int converted = 0;
            int painted = 0;
            int rendererSeen = 0;
            int oldCap = paintCap;
            try
            {
                paintCap = Mathf.Min(paintCap, 256);
                var done = new HashSet<int>();
                RawImage[] raws = UnityEngine.Object.FindObjectsOfType<RawImage>();
                foreach (RawImage raw in raws)
                {
                    if (raw == null || !raw.isActiveAndEnabled) continue;
                    if (!IsBoard(raw.transform)) continue;
                    seen++;
                    string path = PathOf(raw.transform, 10);
                    Texture tex = null;
                    try { tex = raw.texture; } catch { }
                    Texture2D t2 = tex as Texture2D;
                    Color colour;
                    try { colour = raw.color; } catch { colour = Color.white; }
                    if (IsRecOrange(colour)) { try { raw.color = ToRecBlue(colour); } catch { } }
                    try
                    {
                        CanvasRenderer renderer = raw.canvasRenderer;
                        if (renderer != null)
                        {
                            Color vertex = renderer.GetColor();
                            if (IsRecOrange(vertex)) { renderer.SetColor(ToRecBlue(vertex)); painted++; }
                        }
                    }
                    catch { }
                    if (t2 == null)
                    {
                        if (showDiag && seen <= 20) BrandingPlugin.Trace.LogInfo("tableau raw non-2D : " + path + " tex=" + (tex != null ? tex.name : "aucune"));
                        continue;
                    }
                    if (showDiag && seen <= 20) BrandingPlugin.Trace.LogInfo("tableau raw : " + path + " tex=" + (t2.name ?? "") + " " + t2.width + "x" + t2.height);
                    int id = t2.GetInstanceID();
                    if (!done.Add(id) || recoloured.ContainsKey(id) || !boardTextureChecked.Add(id)) continue;
                    Texture2D copy = RecolourTexture(t2);
                    if (copy == null) continue;
                    recoloured[id] = copy;
                    converted++;
                }
                Image[] images = UnityEngine.Object.FindObjectsOfType<Image>();
                foreach (Image image in images)
                {
                    if (image == null || !image.isActiveAndEnabled) continue;
                    if (!IsBoard(image.transform)) continue;
                    seen++;
                    string ipath = PathOf(image.transform, 10);
                    Sprite sprite;
                    try { sprite = image.sprite; } catch { continue; }
                    if (sprite == null) continue;
                    Texture2D t2;
                    try { t2 = sprite.texture; } catch { continue; }
                    if (t2 == null) continue;
                    Color colour;
                    try { colour = image.color; } catch { colour = Color.white; }
                    if (IsRecOrange(colour)) { try { image.color = ToRecBlue(colour); } catch { } }
                    try
                    {
                        CanvasRenderer renderer = image.canvasRenderer;
                        if (renderer != null)
                        {
                            Color vertex = renderer.GetColor();
                            if (IsRecOrange(vertex)) { renderer.SetColor(ToRecBlue(vertex)); painted++; }
                        }
                    }
                    catch { }
                    if (showDiag && seen <= 20) BrandingPlugin.Trace.LogInfo("tableau image : " + ipath + " sprite=" + (sprite.name ?? "") + " tex=" + (t2.name ?? "") + " " + t2.width + "x" + t2.height);
                    int id = t2.GetInstanceID();
                    if (!done.Add(id) || recoloured.ContainsKey(id) || !boardTextureChecked.Add(id)) continue;
                    Texture2D copy = RecolourTexture(t2);
                    if (copy == null) continue;
                    recoloured[id] = copy;
                    converted++;
                }
                Renderer[] renderers = UnityEngine.Object.FindObjectsOfType<Renderer>();
                foreach (Renderer renderer in renderers)
                {
                    if (renderer == null || !renderer.enabled) continue;
                    if (!IsBoard(renderer.transform)) continue;
                    rendererSeen++;
                    string rpath = PathOf(renderer.transform, 10);
                    Material mat = null;
                    try { mat = renderer.material; } catch { }
                    if (mat == null) continue;
                    string matName = mat.name ?? "";
                    Color mc = Color.white;
                    if (mat.HasProperty("_Color")) { try { mc = mat.GetColor("_Color"); } catch { } }
                    Texture main = null;
                    try { main = mat.mainTexture; } catch { }
                    if (showDiag && rendererSeen <= 40) BrandingPlugin.Trace.LogInfo("tableau renderer : " + rpath + " " + renderer.GetType().Name + " mat=" + matName + " color=" + mc + " tex=" + (main != null ? main.name : "aucune"));
                    if (IsRecOrange(mc)) { try { mat.SetColor("_Color", ToRecBlue(mc)); painted++; } catch { } }
                    Texture2D mt = main as Texture2D;
                    int mtId = mt != null ? mt.GetInstanceID() : 0;
                    if (mt != null && done.Add(mtId) && !recoloured.ContainsKey(mtId) && boardTextureChecked.Add(mtId))
                    {
                        Texture2D copy = RecolourTexture(mt);
                        if (copy != null) { try { mat.mainTexture = copy; converted++; } catch { } }
                    }
                }
                if (converted > 0) RebindSprites();
                if (converted > 0 || painted > 0)
                    BrandingPlugin.Trace.LogInfo("tableau : " + converted + " texture(s) recoloree(s), " + painted + " couleur(s) canvas, " + rendererSeen + " renderer(s), " + seen + " image(s) du tableau vues.");
                if (seen > 0) boardDiagShown = true;
                if (Time.realtimeSinceStartup > 60f && seen > 0 && converted == 0) boardTexturesDone = true;
            }
            catch (Exception error) { BrandingPlugin.Trace.LogWarning("tableau : " + error.Message); }
            finally { paintCap = oldCap; }
        }

        private static bool IsLightPanel(Color color)
        {
            if (color.a < 0.2f) return false;
            float h, s, v;
            Color.RGBToHSV(color, out h, out s, out v);
            return v >= 0.6f && s <= 0.18f;
        }

        private static bool IsPanelColour(Color color)
        {
            if (color.a < 0.05f) return false;
            float h, s, v;
            Color.RGBToHSV(color, out h, out s, out v);
            if (s < 0.12f || v < 0.12f) return false;
            if (h >= 0.5f && h <= 0.75f) return false;
            return true;
        }

        private static Color ToPanelBlue(Color color)
        {
            float h, s, v;
            Color.RGBToHSV(color, out h, out s, out v);
            Color result = Color.HSVToRGB(0.58f, Mathf.Clamp(s, 0.42f, 0.82f), Mathf.Clamp(v, 0.35f, 0.9f));
            result.a = color.a;
            return result;
        }

        // Bleu du tableau d'accueil : teinte 0,585 (le bleu REC BLUE, entre l'azur et le bleu
        // roi), saturation et valeur bornees pour retrouver le bleu soutenu des panneaux et
        // du bandeau. La teinte 0,72 donnait un violet : c'est elle qu'on corrige ici.
        private static Color ToBoardBlue(Color color)
        {
            float h, s, v;
            Color.RGBToHSV(color, out h, out s, out v);
            // Deja bleu (une passe precedente est passee) : on ne retouche pas, sinon la
            // saturation monte de 0,12 a chaque affichage du panneau et il finit tout noir.
            if (Mathf.Abs(h - 0.585f) < 0.035f && s >= 0.45f) return color;
            Color result = Color.HSVToRGB(0.585f, Mathf.Clamp(s + 0.12f, 0.52f, 0.86f), Mathf.Clamp(v, 0.48f, 0.86f));
            result.a = color.a;
            return result;
        }

        // ---------------------------------------------------------------- textures
        private static bool IsWarmColour(Color32 pixel)
        {
            if (pixel.a < 8) return false;
            int max = Mathf.Max(pixel.r, Mathf.Max(pixel.g, pixel.b));
            int min = Mathf.Min(pixel.r, Mathf.Min(pixel.g, pixel.b));
            if (max < 90) return false;
            if (max - min < 30) return false;          // gris / blanc : on ne touche pas
            if (pixel.r < pixel.g || pixel.g < pixel.b) return false;  // froid : on ne touche pas
            // Equivalent entier de "teinte < 0,14" : 100*(g-b) < 84*(r-b).
            // Un RGBToHSV par pixel sur une texture 1024x1024 = 1 million de conversions,
            // et ce sont ces blits qui gelaient le jeu 200-600 ms (mesure A/B).
            // Rapport (g-b)/(r-b) : orange 0,41, orange clair 0,60, or 0,72, jaune 0,84.
            // Seuil a 62 : l'orange passe, l'or des etoiles de notation reste dore.
            return 100 * ((int)pixel.g - pixel.b) < 62 * ((int)pixel.r - pixel.b);
        }

        private static bool IsKnownFlatUITexture(Texture2D texture)
        {
            if (texture == null || texture.name == null) return false;
            return texture.name.StartsWith("MenuIcon_Sprites", StringComparison.OrdinalIgnoreCase);
        }

        private Texture2D RecolourTexture(Texture2D source)
        {
            if (source != null && source.name != null
                && source.name.IndexOf("_recblue", StringComparison.OrdinalIgnoreCase) >= 0) return null;
            if (IsKnownFlatUITexture(source)) return null;
            int w = source.width;
            int h = source.height;
            // Les planches d'interface du jeu depassent souvent 4096 px : les ignorer
            // laissait les barres et les aplats en orange.
            // Les planches d'interface mesurees font 1024x1024 ou 512x512. Un atlas plus
            // grand coute des centaines de ms en un seul blit (mesure : 4-7 fps au
            // demarrage), et le budget par frame ne peut pas le decouper. On l'ignore.
            // Plafond en pixels, pas en cote : un bandeau d'en-tete tres large et bas
            // (2048x256) etait refuse par la limite de cote et restait orange.
            // Le budget vient du fichier de reglage : 512 (balanced) ou 1024 (branding).
            if (w < 16 || h < 16 || (long)w * h > (long)paintCap * paintCap)
            {
                return null;
            }

            Texture2D copy = null;
            RenderTexture target = null;
            RenderTexture previous = RenderTexture.active;
            try
            {
                target = RenderTexture.GetTemporary(w, h, 0, RenderTextureFormat.ARGB32);
                Graphics.Blit(source, target);
                RenderTexture.active = target;
                copy = new Texture2D(w, h, TextureFormat.RGBA32, false);
                copy.ReadPixels(new Rect(0, 0, w, h), 0, 0);
                copy.Apply();
            }
            catch { }
            finally
            {
                RenderTexture.active = previous;
                if (target != null) RenderTexture.ReleaseTemporary(target);
            }
            if (copy == null) return null;

            Color32[] pixels = copy.GetPixels32();
            int hit = 0;
            for (int i = 0; i < pixels.Length; i++)
            {
                if (!IsWarmColour(pixels[i])) continue;
                Color32 warm = pixels[i];
                // Remappage lineaire rouge -> bleu : trois multiplications par pixel au lieu
                // d'un RGBToHSV + HSVToRGB. C'est ce couple qui faisait les gels de 200 ms
                // sur les planches 1024, donc le cout principal de la montre.
                // (241,118,31) -> (5,83,228) ; (255,200,120) -> (21,134,242).
                int nr = (int)(warm.b * 0.18f);
                int ng = (int)(warm.g * 0.62f + 10f);
                int nb = (int)(warm.r * 0.95f);
                pixels[i] = new Color32(
                    (byte)(nr > 255 ? 255 : nr),
                    (byte)(ng > 255 ? 255 : ng),
                    (byte)(nb > 255 ? 255 : nb),
                    warm.a);
                hit++;
            }

            if (hit < pixels.Length / 300)
            {
                BrandingPlugin.Trace.LogInfo("texture ignoree (peu d'orange " + hit + "/" + pixels.Length + ") : " + source.name);
                Destroy(copy);
                return null;
            }
            copy.Apply();
            copy.name = source.name + "_recblue";
            BrandingPlugin.Trace.LogInfo("texture : " + source.name + " " + w + "x" + h + " -> " + hit + " pixel(s)");
            return copy;
        }

        private void Enqueue()
        {
            // Une enumeration complete des Image coute une frame quand l'interface vient de
            // s'ouvrir : on la reporte tant que le jeu n'est pas revenu au calme.
            if (Time.unscaledDeltaTime > 0.05f)
            {
                nextEnqueue = Time.realtimeSinceStartup + 0.5f;
                return;
            }
            frameEnqueue = true;
            try
            {
                Image[] images = Resources.FindObjectsOfTypeAll<Image>();
                foreach (Image image in images)
                {
                    if (image == null) continue;
                    Sprite sprite;
                    try { sprite = image.sprite; } catch { continue; }
                    if (sprite == null) continue;
                    Texture2D texture;
                    try { texture = sprite.texture; } catch { continue; }
                    if (texture == null || title != null && texture == title) continue;
                    string name;
                    try { name = texture.name ?? ""; } catch { name = ""; }
                    if (name == "RecBlueTitle.png" || name.EndsWith("_recblue", StringComparison.Ordinal)) continue;
                    int id;
                    try { id = texture.GetInstanceID(); } catch { continue; }
                    if (!seenTextures.Add(id)) continue;
                    queue.Add(texture);
                }
            }
            catch { }
        }

        private void ProcessQueue()
        {
            if (queue.Count == 0) return;
            if (Time.realtimeSinceStartup < texturePauseUntil) return;
            // Une frame deja lente (animation de la montre, chargement) ne doit pas recevoir
            // un blit supplementaire : on le reporte a la frame suivante.
            if (Time.unscaledDeltaTime > 0.04f) return;
            // Une conversion = un blit RenderTexture + lecture de pixels : plusieurs dans la
            // meme frame font chuter le framerate d'un coup. Budget de 6 ms par frame.
            System.Diagnostics.Stopwatch watch = System.Diagnostics.Stopwatch.StartNew();
            int done = 0;
            while (queue.Count > 0)
            {
                Texture2D source = queue[0];
                queue.RemoveAt(0);
                if (source == null) continue;
                try
                {
                    Texture2D copy = RecolourTexture(source);
                    if (copy != null)
                    {
                        int id = source.GetInstanceID();
                        recoloured[id] = copy;
                        texturesDone++;
                        frameBlit = true;
                    }
                }
                catch (Exception error) { BrandingPlugin.Trace.LogWarning("texture : " + error.Message); }
                done++;
                if (watch.Elapsed.TotalMilliseconds >= 60.0)
                {
                    // Blit lourd : on laisse le jeu respirer pour que les gels restent
                    // espaces au lieu de s'enchainer.
                    texturePauseUntil = Time.realtimeSinceStartup + 3f;
                    break;
                }
                if (done >= 1 && watch.Elapsed.TotalMilliseconds >= 1.5) break;
            }
        }

        private void RebindSprites()
        {
            if (recoloured.Count == 0) return;
            int swapped = 0;
            int packedSkipped = 0;
            int rawSwapped = 0;

            // RawImage : on remplace juste la texture, aucun sprite a reconstruire.
            try
            {
                RawImage[] raws = UnityEngine.Object.FindObjectsOfType<RawImage>();
                foreach (RawImage raw in raws)
                {
                    // Les objets inactifs representent des centaines de gabarits : les
                    // parcourir a chaque rebind coutait les gels mesures (433 ms). Ils seront
                    // traites quand ils deviendront actifs.
                    if (raw == null || !raw.isActiveAndEnabled) continue;
                    Texture currentTex;
                    try { currentTex = raw.texture; } catch { continue; }
                    if (currentTex == null) continue;
                    Texture2D replacement;
                    if (!recoloured.TryGetValue(currentTex.GetInstanceID(), out replacement)) continue;
                    try { raw.texture = replacement; rawSwapped++; } catch { }
                }
            }
            catch { }

            try
            {
                Image[] images = Resources.FindObjectsOfTypeAll<Image>();
                foreach (Image image in images)
                {
                    if (image == null || !image.isActiveAndEnabled) continue;
                    Sprite current;
                    try { current = image.sprite; } catch { continue; }
                    if (current == null) continue;
                    bool packed = false;
                    try { packed = current.packed; } catch { }
                    Texture2D texture;
                    try { texture = current.texture; } catch { continue; }
                    if (texture == null) continue;
                    Texture2D replacement;
                    if (!recoloured.TryGetValue(texture.GetInstanceID(), out replacement)) continue;

                    int key = current.GetInstanceID();
                    Sprite sprite;
                    if (!newSprites.TryGetValue(key, out sprite))
                    {
                        try
                        {
                            // Un sprite d'atlas se decrit dans l'espace de l'atlas (textureRect),
                            // pas dans l'espace de l'image d'origine (rect) : utiliser rect ici
                            // affichait une mauvaise zone de l'atlas.
                            Rect region = packed ? current.textureRect : current.rect;
                            if (region.width < 2f || region.height < 2f) { packedSkipped++; continue; }
                            Vector2 pivot;
                            if (packed)
                            {
                                Vector2 offset = current.textureRectOffset;
                                pivot = new Vector2(
                                    (offset.x + current.pivot.x) / region.width,
                                    (offset.y + current.pivot.y) / region.height);
                            }
                            else
                            {
                                pivot = new Vector2(
                                    current.pivot.x / region.width,
                                    current.pivot.y / region.height);
                            }
                            sprite = Sprite.Create(replacement, region, pivot, current.pixelsPerUnit, 0, SpriteMeshType.FullRect, current.border);
                            sprite.name = current.name;
                            newSprites[key] = sprite;
                        }
                        catch { packedSkipped++; continue; }
                    }
                    try { image.sprite = sprite; swapped++; } catch { }
                }
            }
            catch (Exception error) { BrandingPlugin.Trace.LogWarning("sprite : " + error.Message); }
            BrandingPlugin.Trace.LogInfo("textures : " + texturesDone + " recoloree(s), " + swapped + " sprite(s) remplace(s), " + rawSwapped + " rawimage(s), " + packedSkipped + " sprite(s) d'atlas laisse(s).");
        }

        // ---------------------------------------------------------------- boucle
        // Diagnostic : identifie les grands elements d'interface et leur source de couleur
        // (texture ou teinte), pour savoir ou vit encore l'orange.
        private void DiagnoseLarge(float now)
        {
            if (diagnosed && now - lastDiagnose < 15f) return;
            diagnosed = true;
            lastDiagnose = now;
            try
            {
                Image[] images = Resources.FindObjectsOfTypeAll<Image>();
                foreach (Image image in images)
                {
                    if (image == null) continue;
                    Rect rect;
                    try { rect = image.rectTransform.rect; } catch { continue; }
                    if (rect.width < 260f || rect.height < 60f) continue;
                    string go = "?";
                    try { go = image.gameObject != null ? image.gameObject.name : "?"; } catch { }
                    Sprite sprite;
                    string spriteName = "aucun";
                    string textureName = "aucun";
                    bool packed = false;
                    try
                    {
                        sprite = image.sprite;
                        if (sprite != null)
                        {
                            spriteName = sprite.name ?? "?";
                            packed = sprite.packed;
                            if (sprite.texture != null) textureName = sprite.texture.name ?? "?";
                        }
                    }
                    catch { }
                    Color colour = new Color(-1f, -1f, -1f, -1f);
                    try { colour = image.color; } catch { }
                    string state = IsRecOrange(colour) ? " TEINTE-ORANGE" : "";
                }
            }
            catch { }
        }

        // ---------------------------------------------------------------- fond de login
        // Le fond orange a motifs n'est ni une couleur d'interface ni une sprite classique.
        // On le retrouve en cherchant la grande texture dominee par des pixels chauds, puis on
        // remplace cette texture par le fond bleu prepar par l'utilisateur.
        private bool backdropDone;
        private bool backdropLoadTried;
        private Sprite backdropSprite;
        private GameObject backdropObject;

        // Le fond orange du login ne vient ni des couleurs ni des textures d'interface
        // identifiables. Plutot que de le chercher indefiniment, on pose le fond bleu
        // prepare en premier enfant du canvas qui porte le bouton JOUER : il passe
        // derriere tout le panneau, disparait quand ce canvas s'en va, et ne coute rien.
        private void BackdropOverlay()
        {
            if (!backdropLoadTried)
            {
                backdropLoadTried = true;
                Texture2D art = Load("RecLoginBackdrop.png");
                if (art != null)
                {
                    art.name = "RecLoginBackdrop";
                    backdropSprite = Sprite.Create(art, new Rect(0f, 0f, art.width, art.height), new Vector2(0.5f, 0.5f), 100f);
                    backdropSprite.name = "RecLoginBackdropSprite";
                }
                else BrandingPlugin.Trace.LogWarning("fond : image absente du plugin");
            }
            if (backdropSprite == null) return;

            Canvas target = null;
            try
            {
                Image[] images = Resources.FindObjectsOfTypeAll<Image>();
                foreach (Image image in images)
                {
                    if (image == null) continue;
                    Sprite sprite;
                    try { sprite = image.sprite; } catch { continue; }
                    if (sprite == null) continue;
                    string name;
                    try { name = sprite.name ?? ""; } catch { name = ""; }
                    if (name.IndexOf("Primary_Button", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    try { target = image.canvas; } catch { }
                    if (target == null) BrandingPlugin.Trace.LogInfo("fond : canvas null pour " + name);
                    if (target == null) { try { target = image.GetComponentInParent<Canvas>(); } catch { } }
                    if (target == null) { try { target = image.transform.root.GetComponentInChildren<Canvas>(); } catch { } }
                    if (target != null)
                    {
                        BrandingPlugin.Trace.LogInfo("fond : canvas du login trouve (" + name + ")");
                        break;
                    }
                }
            }
            catch { }

            if (target == null || target.gameObject == null)
            {
                if (backdropObject != null)
                {
                    try { Destroy(backdropObject); } catch { }
                    backdropObject = null;
                }
                return;
            }
            if (backdropObject != null) return;

            try
            {
                backdropObject = new GameObject("RecBlueLoginBackdrop");
                backdropObject.transform.SetParent(target.transform, false);
                Image layer = backdropObject.AddComponent<Image>();
                layer.sprite = backdropSprite;
                layer.type = Image.Type.Simple;
                layer.raycastTarget = false;
                RectTransform rect = backdropObject.GetComponent<RectTransform>();
                if (rect != null)
                {
                    rect.anchorMin = Vector2.zero;
                    rect.anchorMax = Vector2.one;
                    rect.offsetMin = Vector2.zero;
                    rect.offsetMax = Vector2.zero;
                }
                backdropObject.transform.SetAsFirstSibling();
                BrandingPlugin.Trace.LogInfo("fond : fond bleu pose sur le canvas du login");
            }
            catch (Exception error)
            {
                BrandingPlugin.Trace.LogWarning("fond : " + error.Message);
                backdropObject = null;
            }
        }

        // ------------------------------------------------------ fond bleu du login
        // Le fond du login est un grand aplat a motifs, dessine hors des canvas
        // classiques. On repeint la plus grande texture de la scene avec notre motif
        // bleu : tout ce qui la dessine change d'un coup, sans toucher a la mise en page.
        // La lecture de pixels (WarmRatio) levait une exception en IL2CPP et faisait
        // tout echouer en silence : on choisit donc sur la taille, pas sur la couleur.
        private bool backdropPainted;
        private bool backdropMissingLogged;
        private bool backdropListed;

        // Copie notre motif dans la texture cible, redimensionne a sa taille.
        private static bool CopyPixels(Texture2D source, Texture2D target)
        {
            RenderTexture buffer = null;
            RenderTexture previous = RenderTexture.active;
            try
            {
                buffer = RenderTexture.GetTemporary(target.width, target.height, 0, RenderTextureFormat.ARGB32);
                Graphics.Blit(source, buffer);
                RenderTexture.active = buffer;
                target.ReadPixels(new Rect(0f, 0f, target.width, target.height), 0, 0);
                target.Apply(false, false);
                return true;
            }
            catch { return false; }
            finally
            {
                RenderTexture.active = previous;
                if (buffer != null) RenderTexture.ReleaseTemporary(buffer);
            }
        }

        private void SwapLoginBackdrop()
        {
            if (backdropPainted) return;
            // Le fond du login n'est a l'ecran qu'au demarrage.
            if (Time.realtimeSinceStartup > 90f) return;
            try
            {
                if (!backdropLoadTried)
                {
                    backdropLoadTried = true;
                    Texture2D art = Load("RecLoginBackdrop.png");
                    if (art != null)
                    {
                        art.name = "RecLoginBackdrop";
                        backdropSprite = Sprite.Create(art, new Rect(0f, 0f, art.width, art.height), new Vector2(0.5f, 0.5f), 100f);
                        backdropSprite.name = "RecLoginBackdropSprite";
                    }
                    else BrandingPlugin.Trace.LogWarning("fond : image absente du plugin");
                }
                if (backdropSprite == null) return;

                Texture2D best = null;
                int bestArea = 0;
                List<string> tops = new List<string>();
                foreach (Texture2D candidate in Resources.FindObjectsOfTypeAll<Texture2D>())
                {
                    if (candidate == null) continue;
                    int width;
                    int height;
                    try { width = candidate.width; height = candidate.height; } catch { continue; }
                    if (width < 512 || height < 256) continue;
                    string label;
                    try { label = candidate.name ?? ""; } catch { label = ""; }
                    if (label == "RecLoginBackdrop" || label.StartsWith("RecBlue", StringComparison.Ordinal)) continue;
                    int area = width * height;
                    if (tops.Count < 6) tops.Add(label + " " + width + "x" + height);
                    if (area <= bestArea) continue;
                    bestArea = area;
                    best = candidate;
                }
                if (!backdropListed && tops.Count > 0)
                {
                    backdropListed = true;
                    BrandingPlugin.Trace.LogInfo("fond : plus grandes textures " + string.Join(" ; ", tops.ToArray()));
                }
                if (best == null)
                {
                    if (!backdropMissingLogged)
                    {
                        backdropMissingLogged = true;
                        BrandingPlugin.Trace.LogInfo("fond : aucune grande texture trouvee");
                    }
                    return;
                }
                string chosen = best.name;
                int chosenWidth = best.width;
                int chosenHeight = best.height;
                if (!CopyPixels(backdropSprite.texture, best))
                {
                    BrandingPlugin.Trace.LogWarning("fond : copie impossible sur " + chosen);
                    return;
                }
                backdropPainted = true;
                BrandingPlugin.Trace.LogInfo("fond : texture " + chosen + " " + chosenWidth + "x" + chosenHeight + " repeinte en bleu");
            }
            catch (Exception error)
            {
                BrandingPlugin.Trace.LogWarning("fond : " + error.Message);
            }
        }

        private static float WarmRatio(Texture2D source)
        {
            RenderTexture target = null;
            RenderTexture previous = RenderTexture.active;
            Texture2D probe = null;
            float ratio = 0f;
            try
            {
                target = RenderTexture.GetTemporary(64, 64, 0, RenderTextureFormat.ARGB32);
                Graphics.Blit(source, target);
                RenderTexture.active = target;
                probe = new Texture2D(64, 64, TextureFormat.RGBA32, false);
                probe.ReadPixels(new Rect(0f, 0f, 64f, 64f), 0, 0);
                probe.Apply();
                Color32[] pixels = probe.GetPixels32();
                int warm = 0;
                for (int i = 0; i < pixels.Length; i++) if (IsWarmColour(pixels[i])) warm++;
                ratio = warm / (float)Mathf.Max(1, pixels.Length);
            }
            catch { }
            finally
            {
                RenderTexture.active = previous;
                if (target != null) RenderTexture.ReleaseTemporary(target);
                if (probe != null) Destroy(probe);
            }
            return ratio;
        }

        private void BackdropPass()
        {
            if (backdropDone) return;
            backdropDone = true;

            Texture2D art = Load("RecLoginBackdrop.png");
            if (art == null)
            {
                BrandingPlugin.Trace.LogWarning("fond : image absente du plugin");
                return;
            }
            art.hideFlags = HideFlags.DontUnloadUnusedAsset;

            Texture2D best = null;
            float bestScore = 0f;
            string leader = "?";
            List<string> tops = new List<string>();
            try
            {
                Texture2D[] all = Resources.FindObjectsOfTypeAll<Texture2D>();
                foreach (Texture2D candidate in all)
                {
                    if (candidate == null) continue;
                    int w = candidate.width;
                    int h = candidate.height;
                    if (w < 512 || h < 256 || w > 4096 || h > 4096) continue;
                    float ratio = WarmRatio(candidate);
                    if (ratio < 0.25f) continue;
                    if (tops.Count < 6) tops.Add(candidate.name + " " + w + "x" + h + " " + ratio.ToString("0.00"));
                    float score = ratio * (w * (float)h);
                    if (score <= bestScore) continue;
                    bestScore = score;
                    best = candidate;
                    leader = candidate.name;
                }
            }
            catch { }
            if (tops.Count > 0) BrandingPlugin.Trace.LogInfo("fond : candidats " + string.Join(" ; ", tops.ToArray()));
            if (best == null)
            {
                BrandingPlugin.Trace.LogInfo("fond : aucune texture orange de fond trouvee");
                return;
            }
            BrandingPlugin.Trace.LogInfo("fond : texture " + leader + " " + best.width + "x" + best.height + " remplacee");

            int images = 0;
            int raws = 0;
            int materials = 0;
            int spritesWorld = 0;

            try
            {
                Sprite artSprite = Sprite.Create(art, new Rect(0f, 0f, art.width, art.height), new Vector2(0.5f, 0.5f), 100f);
                Image[] list = Resources.FindObjectsOfTypeAll<Image>();
                foreach (Image image in list)
                {
                    if (image == null) continue;
                    Sprite current;
                    try { current = image.sprite; } catch { continue; }
                    if (current == null) continue;
                    Texture2D texture;
                    try { texture = current.texture; } catch { continue; }
                    if (texture != best) continue;
                    try
                    {
                        image.sprite = artSprite;
                        image.type = Image.Type.Simple;
                        images++;
                    }
                    catch { }
                }
            }
            catch { }

            try
            {
                RawImage[] list = UnityEngine.Object.FindObjectsOfType<RawImage>();
                foreach (RawImage raw in list)
                {
                    if (raw == null) continue;
                    Texture current;
                    try { current = raw.texture; } catch { continue; }
                    if (current != best) continue;
                    try { raw.texture = art; raws++; } catch { }
                }
            }
            catch { }

            try
            {
                SpriteRenderer[] list = Resources.FindObjectsOfTypeAll<SpriteRenderer>();
                foreach (SpriteRenderer renderer in list)
                {
                    if (renderer == null) continue;
                    Sprite current;
                    try { current = renderer.sprite; } catch { continue; }
                    if (current == null) continue;
                    Texture2D texture;
                    try { texture = current.texture; } catch { continue; }
                    if (texture != best) continue;
                    try
                    {
                        renderer.sprite = Sprite.Create(art, new Rect(0f, 0f, art.width, art.height), new Vector2(0.5f, 0.5f), 100f);
                        spritesWorld++;
                    }
                    catch { }
                }
            }
            catch { }

            try
            {
                Renderer[] list = Resources.FindObjectsOfTypeAll<Renderer>();
                foreach (Renderer renderer in list)
                {
                    if (renderer == null) continue;
                    Material material;
                    try { material = renderer.sharedMaterial; } catch { continue; }
                    if (material == null) continue;
                    // Sans cette garde, Unity inonde la console : un materiau dont le shader
                    // n'a pas de _MainTex (grille MakerPen) declenche un avertissement a
                    // chaque lecture de mainTexture.
                    bool hasMain = false;
                    try { hasMain = material.HasProperty("_MainTex"); } catch { }
                    if (!hasMain) continue;
                    Texture current;
                    try { current = material.GetTexture("_MainTex"); } catch { continue; }
                    if (current != best) continue;
                    try { material.SetTexture("_MainTex", art); materials++; } catch { }
                }
            }
            catch { }

            BrandingPlugin.Trace.LogInfo("fond : " + images + " image(s), " + raws + " rawimage(s), " + spritesWorld + " sprite(s) 3d, " + materials + " materiau(x) remplaces");
        }

        // Les libelles du jeu sont en TextMeshPro : on ne peut pas les reconnaître par
        // leur texte. On part donc de la structure : bouton JOUER (sprite Primary_Button)
        // puis la ligne suivant CHANGER DE COMPTE, et l'objet nomme LanguageSelection.
        private bool languageMoved2;
        private bool languageLogged;

        private static bool IsJouerSprite(string name)
        {
            return !string.IsNullOrEmpty(name) && name.IndexOf("Primary_Button", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static Transform FindNamed(string wanted)
        {
            Transform[] all = Resources.FindObjectsOfTypeAll<Transform>();
            foreach (Transform candidate in all)
            {
                if (candidate == null) continue;
                string name;
                try { name = candidate.name ?? ""; } catch { continue; }
                if (name == wanted) return candidate;
            }
            return null;
        }

        private static RectTransform Rect(Transform source)
        {
            try { return source.GetComponent<RectTransform>(); } catch { return null; }
        }

        private void MoveLanguageRow2()
        {
            if (languageMoved2) return;
            Transform jouerRow = null;
            try
            {
                Image[] images = Resources.FindObjectsOfTypeAll<Image>();
                foreach (Image image in images)
                {
                    if (image == null) continue;
                    Sprite sprite;
                    try { sprite = image.sprite; } catch { continue; }
                    if (sprite == null) continue;
                    string spriteName;
                    try { spriteName = sprite.name ?? ""; } catch { continue; }
                    if (!IsJouerSprite(spriteName)) continue;
                    RectTransform rect = null;
                    try { rect = image.rectTransform; } catch { }
                    if (rect != null && rect.rect.width < 200f) continue;
                    jouerRow = Climb(image.transform);
                    if (jouerRow != null) break;
                }
            }
            catch { }
            if (jouerRow == null || jouerRow.parent == null)
            {
                return;
            }

            Transform parent = jouerRow.parent;
            Transform languageRow = FindNamed("LanguageSelection");
            if (languageRow == null)
            {
                if (!languageLogged)
                {
                    languageLogged = true;
                    string names = "";
                    for (int i = 0; i < parent.childCount && i < 12; i++)
                    {
                        Transform child = parent.GetChild(i);
                        string childName = "?";
                        try { childName = child != null ? child.name : "?"; } catch { }
                        names += childName + " | ";
                    }
                }
                return;
            }

            Transform language = Climb(languageRow);
            if (language == null || language.parent != parent)
            {
                if (!languageLogged) { languageLogged = true; BrandingPlugin.Trace.LogInfo("login : LanguageSelection hors du panneau"); }
                return;
            }

            try
            {
                int jouerIndex = jouerRow.GetSiblingIndex();
                Transform confirmRow = jouerIndex + 1 < parent.childCount ? parent.GetChild(jouerIndex + 1) : null;
                int wanted = confirmRow != null ? jouerIndex + 2 : jouerIndex + 1;
                language.SetSiblingIndex(Mathf.Min(wanted, parent.childCount - 1));

                RectTransform languageRect = Rect(language);
                RectTransform anchorRect = Rect(confirmRow != null ? confirmRow : jouerRow);
                if (languageRect != null && anchorRect != null)
                {
                    float y = anchorRect.anchoredPosition.y - anchorRect.rect.height * 0.5f - 14f - languageRect.rect.height * 0.5f;
                    languageRect.anchoredPosition = new Vector2(anchorRect.anchoredPosition.x, y);
                }
                languageMoved2 = true;
                BrandingPlugin.Trace.LogInfo("login : langue deplacee sous CHANGER DE COMPTE");
            }
            catch (Exception error) { BrandingPlugin.Trace.LogWarning("login : " + error.Message); }
        }

        // Version qui marche : on localise le bouton JOUER et la ligne LanguageSelection
        // par leurs composants Image, puis on remonte au plus proche ancetre commun et on
        // remet la langue apres CHANGER DE COMPTE (la ligne qui suit JOUER).
        private bool languageMoved3;
        private bool languageLogged3;

        // Diagnostic : liste les enfants du panneau de login et les menus deroulants charges,
        // pour savoir comment viser la ligne de langue.
        private void DescribeLoginPanel(Transform jouer)
        {
            try
            {
                int tmpro = 0;
                int uGui = 0;
                foreach (TMPro.TMP_Dropdown dropdown in Resources.FindObjectsOfTypeAll<TMPro.TMP_Dropdown>())
                    if (dropdown != null) tmpro++;
                foreach (Dropdown dropdown in Resources.FindObjectsOfTypeAll<Dropdown>())
                    if (dropdown != null) uGui++;
            }
            catch { }

            try
            {
                Transform titleTransform = null;
                Image[] images = Resources.FindObjectsOfTypeAll<Image>();
                foreach (Image image in images)
                {
                    if (image == null) continue;
                    Sprite sprite;
                    try { sprite = image.sprite; } catch { continue; }
                    if (sprite == null) continue;
                    string name;
                    try { name = sprite.name ?? ""; } catch { continue; }
                    if (name != "RecBlueTitle") continue;
                    titleTransform = image.transform;
                    break;
                }
                if (titleTransform == null || jouer == null)
                {
                    return;
                }
                Transform panel = Common(titleTransform, jouer);
                if (panel == null)
                {
                    return;
                }
                for (int i = 0; i < panel.childCount && i < 10; i++)
                {
                    Transform child = panel.GetChild(i);
                    if (child == null) continue;
                    RectTransform rect = Rect(child);
                    int height = rect != null ? Mathf.RoundToInt(rect.rect.height) : -1;
                }
            }
            catch (Exception error) { BrandingPlugin.Trace.LogWarning("diag panneau : " + error.Message); }
        }

        // Version deterministe : on part de notre propre titre (sprite RecBlueTitle) pour
        // trouver le panneau du login, puis du bouton JOUER qui est dedans. La ligne de
        // langue est celle juste avant JOUER ; on la remet apres CHANGER DE COMPTE.
        private bool languageMoved4;
        private bool languageLogged4;

        private void MoveLanguageRow4()
        {
            if (!BrandingPlugin.EnableLoginLayout) return;
            if (languageMoved4) return;
            try
            {
                // Objets actifs seulement : la liste complete des images chargees coutait
                // plus de 100 ms et bloquait une frame a chaque tentative de placement.
                Image[] images = UnityEngine.Object.FindObjectsOfType<Image>();

                // 1) notre titre, puis le panneau qui le contient
                Transform titleTransform = null;
                foreach (Image image in images)
                {
                    if (image == null) continue;
                    Sprite sprite;
                    try { sprite = image.sprite; } catch { continue; }
                    if (sprite == null) continue;
                    string name;
                    try { name = sprite.name ?? ""; } catch { continue; }
                    if (name != "RecBlueTitle") continue;
                    titleTransform = image.transform;
                    break;
                }
                if (titleTransform == null)
                {
                    return;
                }

                Transform panel = titleTransform;
                int guard = 0;
                while (panel != null && panel.parent != null && guard < 10)
                {
                    RectTransform rect = Rect(panel);
                    if (rect != null && rect.rect.height >= 400f && panel.childCount >= 4) break;
                    panel = panel.parent;
                    guard++;
                }
                if (panel == null || panel.parent == null) return;

                // 2) le bouton JOUER, cherche UNIQUEMENT dans ce panneau
                Transform jouerImage = null;
                foreach (Image image in images)
                {
                    if (image == null) continue;
                    if (ChildUnder(panel, image.transform) == null) continue;
                    Sprite sprite;
                    try { sprite = image.sprite; } catch { continue; }
                    if (sprite == null) continue;
                    string name;
                    try { name = sprite.name ?? ""; } catch { continue; }
                    if (!IsJouerSprite(name)) continue;
                    RectTransform rect = null;
                    try { rect = image.rectTransform; } catch { }
                    if (rect != null && rect.rect.width < 200f) continue;
                    jouerImage = image.transform;
                    break;
                }
                if (jouerImage == null)
                {
                    if (!languageLogged4)
                    {
                        languageLogged4 = true;
                        string names = "";
                        for (int i = 0; i < panel.childCount && i < 10; i++)
                        {
                            Transform child = panel.GetChild(i);
                            string childName = child != null ? child.name : "?";
                            names += childName + " | ";
                        }
                    }
                    return;
                }

                Transform jouerRow = ChildUnder(panel, jouerImage);
                if (jouerRow == null)
                {
                    if (!languageLogged4) { languageLogged4 = true; BrandingPlugin.Trace.LogInfo("login : bouton hors du panneau trouve"); }
                    return;
                }
                int jouerIndex = jouerRow.GetSiblingIndex();
                if (jouerIndex < 1)
                {
                    if (!languageLogged4) { languageLogged4 = true; BrandingPlugin.Trace.LogInfo("login : JOUER en position " + jouerIndex); }
                    return;
                }

                Transform languageRow = panel.GetChild(jouerIndex - 1);
                RectTransform languageRect = Rect(languageRow);
                if (languageRect == null) return;
                float width = languageRect.rect.width;
                float height = languageRect.rect.height;
                if (width < 450f || height > 170f)
                {
                    if (!languageLogged4)
                    {
                        languageLogged4 = true;
                        BrandingPlugin.Trace.LogInfo("login : ligne avant JOUER = " + languageRow.name + " " + Mathf.RoundToInt(width) + "x" + Mathf.RoundToInt(height) + " (non deplacee)");
                    }
                    return;
                }

                Transform confirmRow = jouerIndex + 1 < panel.childCount ? panel.GetChild(jouerIndex + 1) : jouerRow;
                int target = Mathf.Min(confirmRow.GetSiblingIndex() + 1, panel.childCount - 1);
                languageRow.SetSiblingIndex(target);

                RectTransform confirmRect = Rect(confirmRow);
                if (confirmRect != null)
                {
                    float y = confirmRect.anchoredPosition.y - confirmRect.rect.height * 0.5f - 14f - languageRect.rect.height * 0.5f;
                    languageRect.anchoredPosition = new Vector2(confirmRect.anchoredPosition.x, y);
                }
                RectTransform panelRect = Rect(panel);
                if (panelRect != null) LayoutRebuilder.ForceRebuildLayoutImmediate(panelRect);

                languageMoved4 = true;
                BrandingPlugin.Trace.LogInfo("login : langue [" + languageRow.name + "] deplacee sous [" + confirmRow.name + "] dans " + panel.name);
            }
            catch (Exception error) { BrandingPlugin.Trace.LogWarning("login : " + error.Message); }
        }

        private bool languageLoggedDropdown;

        private Transform LanguageFromDropdown()
        {
            try
            {
                TMPro.TMP_Dropdown[] dropdowns = Resources.FindObjectsOfTypeAll<TMPro.TMP_Dropdown>();
                foreach (TMPro.TMP_Dropdown dropdown in dropdowns)
                {
                    if (dropdown == null) continue;
                    bool active = false;
                    try { active = dropdown.gameObject != null && dropdown.gameObject.activeInHierarchy; } catch { }
                    if (!active) continue;
                    if (!languageLoggedDropdown)
                    {
                        languageLoggedDropdown = true;
                        BrandingPlugin.Trace.LogInfo("login : menu deroulant trouve (" + dropdown.gameObject.name + ")");
                    }
                    return dropdown.transform;
                }
            }
            catch { }
            return null;
        }

        private static bool HasAncestorNamed(Transform start, string wanted, int depth)
        {
            Transform current = start;
            for (int i = 0; i <= depth && current != null; i++)
            {
                string name;
                try { name = current.name ?? ""; } catch { name = ""; }
                if (name.IndexOf(wanted, StringComparison.OrdinalIgnoreCase) >= 0) return true;
                current = current.parent;
            }
            return false;
        }

        private static Transform ChildUnder(Transform ancestor, Transform item)
        {
            Transform current = item;
            while (current != null && current.parent != null && current.parent != ancestor) current = current.parent;
            return current != null && current.parent == ancestor ? current : null;
        }

        private static Transform Common(Transform a, Transform b)
        {
            HashSet<Transform> chain = new HashSet<Transform>();
            for (Transform t = a; t != null; t = t.parent) chain.Add(t);
            for (Transform t = b; t != null; t = t.parent) if (chain.Contains(t)) return t;
            return null;
        }

        private void MoveLanguageRow3()
        {
            if (languageMoved3) return;

            Transform jouer = null;
            // Une seule enumeration par passe : la faire dans la boucle des images mettait
            // le jeu a 0 fps (1500 enumerations d'objets par tentative).
            Transform language = LanguageFromDropdown();
            try
            {
                Image[] images = Resources.FindObjectsOfTypeAll<Image>();
                foreach (Image image in images)
                {
                    if (image == null) continue;
                    if (jouer != null) continue;
                    Sprite sprite;
                    try { sprite = image.sprite; } catch { continue; }
                    if (sprite == null) continue;
                    string spriteName;
                    try { spriteName = sprite.name ?? ""; } catch { continue; }
                    if (!IsJouerSprite(spriteName)) continue;
                    RectTransform rect = null;
                    try { rect = image.rectTransform; } catch { }
                    if (rect != null && rect.rect.width < 200f) continue;
                    jouer = image.transform;
                }
            }
            catch { }

            if (jouer == null || language == null)
            {
                if (!languageLogged3)
                {
                    languageLogged3 = true;
                    BrandingPlugin.Trace.LogInfo("login : jouer=" + (jouer != null) + " langue=" + (language != null));
                    DescribeLoginPanel(jouer);
                }
                return;
            }

            try
            {
                Transform common = Common(jouer, language);
                if (common == null) return;
                Transform jouerChild = ChildUnder(common, jouer);
                Transform languageChild = ChildUnder(common, language);
                if (jouerChild == null || languageChild == null || jouerChild == languageChild)
                {
                    if (!languageLogged3) { languageLogged3 = true; BrandingPlugin.Trace.LogInfo("login : jouer et langue dans le meme bloc, rien a deplacer"); }
                    return;
                }

                int jouerIndex = jouerChild.GetSiblingIndex();
                Transform confirmChild = jouerIndex + 1 < common.childCount ? common.GetChild(jouerIndex + 1) : null;
                int wanted = confirmChild != null ? confirmChild.GetSiblingIndex() + 1 : jouerIndex + 1;
                languageChild.SetSiblingIndex(Mathf.Min(wanted, common.childCount - 1));

                RectTransform languageRect = Rect(languageChild);
                RectTransform anchorRect = Rect(confirmChild != null ? confirmChild : jouerChild);
                if (languageRect != null && anchorRect != null)
                {
                    float y = anchorRect.anchoredPosition.y - anchorRect.rect.height * 0.5f - 14f - languageRect.rect.height * 0.5f;
                    languageRect.anchoredPosition = new Vector2(anchorRect.anchoredPosition.x, y);
                }

                RectTransform commonRect = Rect(common);
                if (commonRect != null) LayoutRebuilder.ForceRebuildLayoutImmediate(commonRect);

                languageMoved3 = true;
                BrandingPlugin.Trace.LogInfo("login : langue sous CHANGER DE COMPTE (" + common.name + " / " + languageChild.name + ")");
            }
            catch (Exception error) { BrandingPlugin.Trace.LogWarning("login : " + error.Message); }
        }

        // ---------------------------------------------------------------- ordre du login
        // Le selecteur de langue doit passer SOUS le bouton CHANGER DE COMPTE. On remonte
        // depuis les deux libelles jusqu'au premier parent qui contient plusieurs elements
        // (le panneau), puis on remet la langue apres le bouton dans l'ordre des enfants.
        private bool languageMoved;

        private static Transform Climb(Transform start)
        {
            Transform current = start;
            int guard = 0;
            while (current != null && current.parent != null && current.parent.childCount <= 2 && guard < 12)
            {
                current = current.parent;
                guard++;
            }
            return current;
        }

        private void MoveLanguageRow()
        {
            if (!BrandingPlugin.EnableLoginLayout) return;
            if (languageMoved) return;
            Transform confirm = null;
            Transform language = null;
            try
            {
                Text[] texts = Resources.FindObjectsOfTypeAll<Text>();
                foreach (Text text in texts)
                {
                    if (text == null) continue;
                    string label;
                    try { label = text.text ?? ""; } catch { continue; }
                    if (label.Length == 0) continue;
                    if (confirm == null && label.IndexOf("CHANGER DE COMPTE", StringComparison.OrdinalIgnoreCase) >= 0) confirm = text.transform;
                    if (language == null && (label.IndexOf("Francais", StringComparison.OrdinalIgnoreCase) >= 0 || label.IndexOf("Fran\u00e7ais", StringComparison.OrdinalIgnoreCase) >= 0)) language = text.transform;
                }
            }
            catch { }
            if (confirm == null || language == null) return;

            Transform confirmRow = Climb(confirm);
            Transform languageRow = Climb(language);
            if (confirmRow == null || languageRow == null) return;
            if (confirmRow.parent == null || languageRow.parent == null) return;
            if (confirmRow.parent != languageRow.parent) return;

            try
            {
                languageRow.SetSiblingIndex(confirmRow.GetSiblingIndex() + 1);
                RectTransform confirmRect = confirmRow.GetComponent<RectTransform>();
                RectTransform languageRect = languageRow.GetComponent<RectTransform>();
                if (confirmRect != null && languageRect != null)
                {
                    float y = confirmRect.anchoredPosition.y - confirmRect.rect.height * 0.5f - 12f - languageRect.rect.height * 0.5f;
                    languageRect.anchoredPosition = new Vector2(confirmRect.anchoredPosition.x, y);
                }
                languageMoved = true;
                BrandingPlugin.Trace.LogInfo("login : selecteur de langue place sous CHANGER DE COMPTE");
            }
            catch (Exception error) { BrandingPlugin.Trace.LogWarning("login : " + error.Message); }
        }

        // Diagnostic : liste les grands elements d'image de l'ecran courant (nom du sprite,
        // de la texture, chemin d'objets) pour retrouver le logo du login et du chargement.
        // Ne s'execute que si RECBLUE_DUMP_LOGOS.txt existe dans plugins.
        private bool logoScreenDumped;
        private float nextLogoDumpAt;
        private int logoDumpPass;
        private float nextChargeDump;

        // Sonde des ecrans de chargement : marqueur RECBLUE_DUMP_CHARGEMENT.txt.
        // Journalise une fois par seconde les elements qui portent un visuel de campagne
        // (sprite, texture, materiau), pour savoir exactement quoi remplacer.
        private void DumpLoadingOnce(float now)
        {
            if (!BrandingPlugin.EnableDiagnostics) return;
            try { if (!System.IO.File.Exists("C:/RecRoom2023/BepInEx/plugins/RECBLUE_DUMP_CHARGEMENT.txt")) return; } catch { return; }
            if (now < nextChargeDump) return;
            nextChargeDump = now + 1f;
            try
            {
                Graphic[] graphics = UnityEngine.Object.FindObjectsOfType<Graphic>();
                int logged = 0;
                foreach (Graphic graphic in graphics)
                {
                    if (graphic == null || !graphic.isActiveAndEnabled) continue;
                    string path = PathOf(graphic.transform, 6);
                    string lower = path.ToLowerInvariant();
                    Image image = graphic as Image;
                    RawImage raw = graphic as RawImage;
                    string sprite = "";
                    string texture = "";
                    if (image != null)
                    {
                        try
                        {
                            Sprite s = image.sprite;
                            if (s != null)
                            {
                                sprite = s.name ?? "";
                                if (s.texture != null) texture = s.texture.name ?? "";
                            }
                        }
                        catch { }
                    }
                    if (raw != null) { try { if (raw.texture != null) texture = raw.texture.name ?? ""; } catch { } }
                    string material = "";
                    string materialTexture = "";
                    string shader = "";
                    try
                    {
                        Material m = graphic.material;
                        if (m != null)
                        {
                            material = m.name ?? "";
                            if (m.shader != null) shader = m.shader.name ?? "";
                            if (m.mainTexture != null) materialTexture = m.mainTexture.name ?? "";
                        }
                    }
                    catch { }
                    bool interesting = lower.Contains("loading") || lower.Contains("bootui") || lower.Contains("title screen")
                        || sprite.IndexOf("setup_", StringComparison.OrdinalIgnoreCase) >= 0
                        || texture.IndexOf("setup_", StringComparison.OrdinalIgnoreCase) >= 0
                        || materialTexture.IndexOf("setup_", StringComparison.OrdinalIgnoreCase) >= 0;
                    if (!interesting) continue;
                    Rect rect = default(Rect);
                    try { rect = graphic.rectTransform.rect; } catch { }
                    BrandingPlugin.Trace.LogInfo("charge : " + Mathf.RoundToInt(rect.width) + "x" + Mathf.RoundToInt(rect.height)
                        + " sprite=" + sprite + " tex=" + texture + " mat=" + material + " matTex=" + materialTexture
                        + " shader=" + shader + " chemin=" + path);
                    if (++logged >= 30) break;
                }
            }
            catch { }
            try
            {
                Renderer[] renderers = UnityEngine.Object.FindObjectsOfType<Renderer>();
                int shown = 0;
                foreach (Renderer renderer in renderers)
                {
                    if (renderer == null) continue;
                    Material material = null;
                    try { material = renderer.sharedMaterial; } catch { }
                    if (material == null) continue;
                    string texture = "";
                    try { if (material.mainTexture != null) texture = material.mainTexture.name ?? ""; } catch { }
                    if (texture.IndexOf("setup_", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    BrandingPlugin.Trace.LogInfo("charge mesh : tex=" + texture + " mat=" + (material.name ?? "?") + " chemin=" + PathOf(renderer.transform, 6));
                    if (++shown >= 10) break;
                }
            }
            catch { }
        }

        private void DumpLogoOnce(float now)
        {
            if (!BrandingPlugin.EnableDiagnostics) return;
            if (logoScreenDumped) return;
            try { if (!System.IO.File.Exists("C:/RecRoom2023/BepInEx/plugins/RECBLUE_DUMP_LOGOS.txt")) return; } catch { return; }
            if (now < nextLogoDumpAt) return;
            nextLogoDumpAt = now + 5f;
            if (logoDumpPass >= 12) { logoScreenDumped = true; return; }
            logoDumpPass++;
            BrandingPlugin.Trace.LogInfo("diag logo : --- passe " + logoDumpPass + " (" + Mathf.RoundToInt(now - startedAt) + " s)");
            try
            {
                Image[] images = UnityEngine.Object.FindObjectsOfType<Image>();
                int shown = 0;
                foreach (Image image in images)
                {
                    if (image == null) continue;
                    Rect rect;
                    try { rect = image.rectTransform.rect; } catch { continue; }
                    string path = PathOf(image.transform, 5);
                    string lower = path.ToLowerInvariant();
                    bool boot = lower.Contains("bootui") || lower.Contains("title loading screen");
                    if (!boot && (rect.width < 150f || rect.height < 60f)) continue;
                    Sprite sprite = null;
                    try { sprite = image.sprite; } catch { }
                    string spriteName = "aucun";
                    string textureName = "aucune";
                    if (sprite != null)
                    {
                        try { spriteName = sprite.name ?? "?"; } catch { }
                        try { textureName = sprite.texture != null ? (sprite.texture.name ?? "?") : "?"; } catch { }
                    }
                    BrandingPlugin.Trace.LogInfo("diag logo : " + Mathf.RoundToInt(rect.width) + "x" + Mathf.RoundToInt(rect.height) + " sprite=" + spriteName + " tex=" + textureName + " chemin=" + path);
                    if (++shown >= 25) break;
                }
            }
            catch { }
            try
            {
                RawImage[] raws = UnityEngine.Object.FindObjectsOfType<RawImage>();
                int shownRaw = 0;
                foreach (RawImage raw in raws)
                {
                    if (raw == null) continue;
                    Rect rect;
                    try { rect = raw.rectTransform.rect; } catch { continue; }
                    if (rect.width < 150f || rect.height < 60f) continue;
                    string tex = "aucune";
                    try { tex = raw.texture != null ? (raw.texture.name ?? "?") : "aucune"; } catch { }
                    string path = "";
                    try
                    {
                        Transform t = raw.transform;
                        int guard = 0;
                        while (t != null && guard++ < 4) { path = t.name + "/" + path; t = t.parent; }
                    }
                    catch { }
                    BrandingPlugin.Trace.LogInfo("diag logo : " + Mathf.RoundToInt(rect.width) + "x" + Mathf.RoundToInt(rect.height) + " raw tex=" + tex + " chemin=" + path);
                    if (++shownRaw >= 10) break;
                }
            }
            catch { }
        }

        // Une passe de logo est decoupee : la liste est gardee entre les frames et
        // parcourue par tranches de 0,30 ms. La passe complete coutait 170 ms d'un coup,
        // ce qui se voyait comme un gel a chaque nouvelle image du jeu.
        private Image[] sweepQueue;
        private int sweepCursor;
        private readonly List<Image> logoCanaries = new List<Image>();
        private readonly List<Image> shadowCanaries = new List<Image>();
        private readonly List<Transform> logoRoots = new List<Transform>();
        private float nextLogoWatch;
        private float nextLogoWatchLog;
        private int logoWatchFixes;
        internal static RawImage LoadingTarget;
        private static float loadingHiddenAt;
        private static float nextLoadingFind;
        private float nextLoadingLog;
        private readonly HashSet<Transform> shadowScanDone = new HashSet<Transform>();

        private static bool IsBrandShadowSprite(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            return IsBrandSprite(name) && name.IndexOf("Shadow", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        // Le jeu superpose au logo un calque d'ombre qui porte la forme du logo Rec Room.
        // Une fois converti par le balayage, ce calque affiche notre sprite en double et
        // son contour depasse derriere le logo : on masque tout doublon de la page.
        // Filet de securite : tant que le panneau du logo vit, on le revalide 5 fois par
        // seconde. Coute moins d'une milliseconde et couvre les cas que les gardes ne
        // voient pas (RawImage, sprite pose hors set_sprite).
        private void WatchLogoRoots(float now)
        {
            if (!BrandingPlugin.EnableLogoBranding) return;
            if (safeMode || titleSprite == null) return;
            if (now < nextLogoWatch) return;
            nextLogoWatch = now + 0.2f;
            for (int i = logoRoots.Count - 1; i >= 0; i--)
            {
                Transform root = logoRoots[i];
                if (root == null) { logoRoots.RemoveAt(i); continue; }
                Image[] images;
                try { images = root.GetComponentsInChildren<Image>(true); } catch { continue; }
                foreach (Image image in images)
                {
                    if (image == null) continue;
                    Sprite current = null;
                    try { current = image.sprite; } catch { }
                    string name = "";
                    if (current != null) { try { name = current.name ?? ""; } catch { } }
                    if (!IsBrandSprite(name)) continue;
                    if (IsLoadingLogoPath(PathOf(image.transform, 8))) continue;
                    if (IsBrandShadowSprite(name))
                    {
                        try { if (image.enabled) { image.enabled = false; logoWatchFixes++; } } catch { }
                        if (shadowCanaries.Count < 20 && !shadowCanaries.Contains(image)) shadowCanaries.Add(image);
                        continue;
                    }
                    try
                    {
                        image.sprite = titleSprite;
                        image.preserveAspect = true;
                        logoWatchFixes++;
                        EnlargeLoginLogo(image);
                    }
                    catch { }
                    if (logoCanaries.Count < 40 && !logoCanaries.Contains(image)) logoCanaries.Add(image);
                }
                RawImage[] raws;
                try { raws = root.GetComponentsInChildren<RawImage>(true); } catch { raws = null; }
                if (raws == null) continue;
                foreach (RawImage raw in raws)
                {
                    if (raw == null || raw.texture == null) continue;
                    string textureName = "";
                    try { textureName = raw.texture.name ?? ""; } catch { }
                    if (textureName.Length == 0) continue;
                    if (textureName.IndexOf("RecRoomLogo", StringComparison.OrdinalIgnoreCase) < 0
                        && textureName.IndexOf("RecRoom_Logo", StringComparison.OrdinalIgnoreCase) < 0
                        && textureName.IndexOf("Rec Room Logo", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    if (IsLoadingLogoPath(PathOf(raw.transform, 8))) continue;
                    try { raw.texture = title; logoWatchFixes++; } catch { }
                }
            }
            if (logoWatchFixes > 0 && now >= nextLogoWatchLog)
            {
                nextLogoWatchLog = now + 5f;
                BrandingPlugin.Trace.LogInfo("logo : " + logoWatchFixes + " logo(s) Rec Room intercepte(s) apres reapparition.");
            }
        }

        private void HideLogoDuplicates(Image main)
        {
            try
            {
                Transform root = main.transform;
                for (int up = 0; up < 3 && root.parent != null; up++) root = root.parent;
                if (!shadowScanDone.Add(root)) return;
                if (logoRoots.Count < 4 && !logoRoots.Contains(root)) logoRoots.Add(root);
                Image[] images = root.GetComponentsInChildren<Image>(true);
                int hidden = 0;
                foreach (Image candidate in images)
                {
                    if (candidate == null || candidate == main) continue;
                    bool ours = false;
                    string spriteName = "";
                    try
                    {
                        ours = candidate.sprite == titleSprite;
                        if (candidate.sprite != null) spriteName = candidate.sprite.name ?? "";
                    }
                    catch { }
                    if (!ours && !IsBrandShadowSprite(spriteName)) continue;
                    try
                    {
                        if (candidate.enabled) { candidate.enabled = false; hidden++; }
                        if (shadowCanaries.Count < 20 && !shadowCanaries.Contains(candidate)) shadowCanaries.Add(candidate);
                    }
                    catch { }
                }
                if (hidden > 0)
                    BrandingPlugin.Trace.LogInfo("logo : " + hidden + " doublon(s) / ombre(s) du logo masque(s).");
            }
            catch { }
        }
        private int lastLoggedSwapped = -1;
        private int sweepSwapped;
        private bool sweepDeep;
        private float sweepStartedAt;

        private void Sweep()
        {
            if (!BrandingPlugin.EnableLogoBranding) { sweepQueue = null; return; }
            if (safeMode) return;
            if (titleSprite == null) return;
            frameSweep = true;
            try
            {
                if (sweepQueue == null)
                {
                    // Passe profonde tant que le logo n'est pas pose : les gabarits inactifs
                    // portent le sprite d'origine, et il quitte la scene des que l'ecran de
                    // chargement est passe. Ensuite uniquement les objets actifs.
                    bool deep = !titleSwapped;
                    System.Diagnostics.Stopwatch scan = System.Diagnostics.Stopwatch.StartNew();
                    try
                    {
                        Image[] all = deep
                            ? Resources.FindObjectsOfTypeAll<Image>()
                            : UnityEngine.Object.FindObjectsOfType<Image>();
                        // Seuls les candidats entrent dans la file : sprite de marque, chemin de
                        // marque ou grand cadre. Sans ce filtre, la file comptait des centaines
                        // d'images et mettait plusieurs secondes a atteindre le logo du login :
                        // il s'affichait entre-temps avec le sprite Rec Room d'origine.
                        List<Image> kept = new List<Image>(all.Length);
                        foreach (Image candidate in all)
                        {
                            if (candidate == null) continue;
                            bool keep = false;
                            Sprite current = null;
                            try { current = candidate.sprite; } catch { }
                            if (current != null)
                            {
                                string spriteName = "";
                                try { spriteName = current.name ?? ""; } catch { }
                                keep = IsBrandSprite(spriteName);
                                if (!keep)
                                {
                                    try
                                    {
                                        Texture2D spriteTexture = current.texture;
                                        keep = spriteTexture != null && LoadingArt.IsLoadingTexture(spriteTexture.name ?? "");
                                    }
                                    catch { }
                                }
                            }
                            if (!keep)
                            {
                                Rect box = default(Rect);
                                try { box = candidate.rectTransform.rect; } catch { }
                                keep = box.width >= 300f && box.height >= 120f;
                            }
                            if (keep) kept.Add(candidate);
                        }
                        sweepQueue = kept.ToArray();
                    }
                    catch { sweepQueue = new Image[0]; }
                    sweepCursor = 0;
                    sweepSwapped = 0;
                    sweepDeep = deep;
                    sweepStartedAt = Time.realtimeSinceStartup;
                    if (scan.ElapsedMilliseconds >= 20)
                        BrandingPlugin.Trace.LogInfo("perf : sweep " + scan.ElapsedMilliseconds + " ms, " + sweepQueue.Length + " image(s)" + (deep ? " (profonde)" : ""));
                }
                System.Diagnostics.Stopwatch watch = System.Diagnostics.Stopwatch.StartNew();
                while (sweepCursor < sweepQueue.Length)
                {
                    Image image = sweepQueue[sweepCursor++];
                    if (image != null)
                    {
                        Sprite current = null;
                        try { current = image.sprite; } catch { }
                        string name = "";
                        if (current != null)
                        {
                            try { name = current.name ?? ""; } catch { name = ""; }
                        }
                        if (LoadingArt.IsLoadingTexture(name))
                        {
                            ApplyLoading(image);
                            continue;
                        }
                        bool brand = IsBrandSprite(name);
                        if (!brand)
                        {
                            // Le logo du login et celui du chargement ne portent pas toujours un
                            // sprite au nom attendu : sur une image assez grande pour etre un
                            // logo, on regarde aussi le nom des objets au-dessus d'elle.
                            Rect box = default(Rect);
                            try { box = image.rectTransform.rect; } catch { }
                            if (box.width >= 300f && box.height >= 120f)
                                brand = IsBrandPath(PathOf(image.transform, 5));
                        }
                        if (brand)
                        {
                            if (IsLoadingLogoPath(PathOf(image.transform, 8)))
                            {
                                KeepLoadingLogo();
                                continue;
                            }
                            if (IsBrandShadowSprite(name))
                            {
                                // Le jeu garde un calque "ombre" a la forme du logo Rec Room :
                                // son contour blanc depassait derriere notre logo. On le masque
                                // au lieu de le remplacer.
                                try { image.enabled = false; } catch { }
                                if (shadowCanaries.Count < 20 && !shadowCanaries.Contains(image)) shadowCanaries.Add(image);
                            }
                            else
                            {
                                try
                                {
                                    image.sprite = titleSprite;
                                    // Le cadre d'origine etait prevu pour un logo large : sans ca
                                    // notre image est estiree et deborde de son emplacement.
                                    image.preserveAspect = true;
                                    // Meme largeur que le logo Rec Room remplace (login seulement).
                                    EnlargeLoginLogo(image);
                                    HideLogoDuplicates(image);
                                    sweepSwapped++;
                                    if (logoCanaries.Count < 40 && !logoCanaries.Contains(image)) logoCanaries.Add(image);
                                }
                                catch { }
                            }
                        }
                    }
                    // La passe profonde arrive pendant le chargement : elle doit finir tant que
                    // l'ecran de chargement est la, sinon le logo disparait avant d'etre vu.
                    // Les passes suivantes, repetees, restent bornees a 0,30 ms par frame.
                    if (!sweepDeep && watch.Elapsed.TotalMilliseconds >= 0.30) return;
                }
                if (sweepDeep)
                {
                    int spent = Mathf.RoundToInt((Time.realtimeSinceStartup - sweepStartedAt) * 1000f);
                    if (spent >= 50)
                        BrandingPlugin.Trace.LogInfo("perf : sweep profonde " + spent + " ms (" + sweepQueue.Length + " images)");
                }
                if (sweepSwapped > 0)
                {
                    titleSwapped = true;
                    // Le jeu reconstruit son logo en boucle au demarrage : on ne journalise
                    // qu'au changement de compte pour ne pas noyer le log.
                    if (sweepSwapped != lastLoggedSwapped)
                    {
                        lastLoggedSwapped = sweepSwapped;
                        BrandingPlugin.Trace.LogInfo("marque : " + sweepSwapped + " sprite(s) remplace(s) a " + Mathf.RoundToInt(Time.realtimeSinceStartup) + " s.");
                    }
                }
                // Certains logos passent par une RawImage (texture et non sprite) : on leur
                // substitue la planche du titre pour ne pas laisser un logo orange.
                try
                {
                    RawImage[] raws = UnityEngine.Object.FindObjectsOfType<RawImage>();
                    int rawsDone = 0;
                    foreach (RawImage raw in raws)
                    {
                        if (raw == null) continue;
                        Rect box = default(Rect);
                        try { box = raw.rectTransform.rect; } catch { }
                        if (box.width < 300f || box.height < 120f) continue;
                        if (!IsBrandPath(PathOf(raw.transform, 5))) continue;
                        if (IsLoadingLogoPath(PathOf(raw.transform, 8))) { KeepLoadingLogo(); continue; }
                        try { raw.texture = title; rawsDone++; } catch { }
                    }
                    if (rawsDone > 0)
                        BrandingPlugin.Trace.LogInfo("marque : " + rawsDone + " texture(s) de logo remplacee(s).");
                }
                catch { }
                // Visuels de campagne des ecrans de chargement (setup_..._2560x1440).
                try
                {
                    RawImage[] tips = UnityEngine.Object.FindObjectsOfType<RawImage>();
                    int tipsDone = 0;
                    foreach (RawImage raw in tips)
                    {
                        if (raw == null || raw.texture == null) continue;
                        string textureName = "";
                        try { textureName = raw.texture.name ?? ""; } catch { }
                        if (!LoadingArt.IsLoadingTexture(textureName) && !IsLoadingBackground(raw)) continue;
                        Texture2D replacement = LoadingArt.TextureFor(raw.GetInstanceID());
                        if (replacement == null) continue;
                        try { raw.texture = replacement; raw.uvRect = new Rect(0f, 0f, 1f, 1f); tipsDone++; } catch { }
                        LoadingTarget = raw;
                    }
                    if (tipsDone > 0 && Time.realtimeSinceStartup >= nextLoadingLog)
                    {
                        nextLoadingLog = Time.realtimeSinceStartup + 5f;
                        BrandingPlugin.Trace.LogInfo("chargement : " + tipsDone + " image(s) d'ecran de chargement remplacee(s).");
                    }
                }
                catch { }
                sweepQueue = null;
            }
            catch { sweepQueue = null; }
        }

        // Chemin des objets au-dessus d'un element, borne en profondeur : sert a
        // reconnaitre les logos dont le sprite n'a pas un nom parlant.
        internal static string PathOf(Transform start, int depth)
        {
            string path = "";
            try
            {
                Transform t = start;
                int guard = 0;
                while (t != null && guard++ < depth)
                {
                    string n = t.name ?? "?";
                    path = n + "/" + path;
                    t = t.parent;
                }
            }
            catch { }
            return path;
        }

        private static bool IsBrandPath(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            string p = path.ToLowerInvariant();
            return p.Contains("rec room logo")
                || p.Contains("recroomlogo")
                || p.Contains("image - change icon here");
        }

        // Le logo du login vit sous un panneau "TitleScreen..." / "Cached Account".
        // L'ecran de chargement ("Title Loading Screen") et les splashs sont exclus : eux
        // ont deja la bonne taille et un agrandissement masquerait le panneau.
        private static bool IsLoginLogoPath(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            string p = path.ToLowerInvariant();
            // Le panneau du compte est parfois instancie sous l'ecran de chargement avant
            // d'etre detache : son nom doit primer sur l'exclusion "loading".
            if (p.Contains("cached account") || p.Contains("titlescreen")
                || p.Contains("title screen") || p.Contains("login")) return true;
            if (p.Contains("loading") || p.Contains("splash") || p.Contains("bootui")) return false;
            return false;
        }

        private static bool IsLoadingLogoPath(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            string p = path.ToLowerInvariant();
            if (p.Contains("cached account") || p.Contains("titlescreen")
                || p.Contains("title screen") || p.Contains("login")) return false;
            return p.Contains("loading") || p.Contains("splash") || p.Contains("bootui");
        }

        private static bool loadingLogoKeptLogged;

        private static void KeepLoadingLogo()
        {
            if (loadingLogoKeptLogged) return;
            loadingLogoKeptLogged = true;
            if (BrandingPlugin.Trace != null)
                BrandingPlugin.Trace.LogInfo("logo : ecran de chargement/splash laisse d'origine (logo Rec Room).");
        }

        // Applique l'echelle du logo Rec Room d'origine, une seule fois par objet. Le logo
        // du login arrive apres le chargement (~10 s) : passe 9 s, tout logo qui n'est ni
        // un chargement ni un splash est celui du login.
        private void EnlargeLoginLogo(Image image)
        {
            if (image == null) return;
            Transform t = null;
            try { t = image.transform; } catch { return; }
            if (t == null) return;
            string path = PathOf(t, 6);
            bool login = IsLoginLogoPath(path)
                || (!IsLoadingLogoPath(path) && Time.realtimeSinceStartup > 9f);
            if (!login) return;
            Vector3 baseScale;
            if (!logoBaseScales.TryGetValue(t, out baseScale))
            {
                baseScale = t.localScale;
                logoBaseScales[t] = baseScale;
            }
            Vector3 target = baseScale * LoginLogoScale;
            if ((t.localScale - target).sqrMagnitude <= 0.000001f) return;
            t.localScale = target;
            if (!loginScaleLogged)
            {
                loginScaleLogged = true;
                BrandingPlugin.Trace.LogInfo("logo login : taille Rec Room x" + LoginLogoScale.ToString("0.000") + " (" + path + ")");
            }
        }

        // Appele avant chaque affectation de sprite : le logo Rec Room n'est jamais pose.
        internal static void GuardSprite(Image image, ref Sprite value)
        {
            if (safeMode || value == null) return;
            EnsureDriverActive();
            RequestLateTintFromImage(image);
            TintBackgroundsForGraphic(image);
            if (Time.realtimeSinceStartup >= 6f) ApplyTitleStatic();
            if (IsLoginLogoPath(PathOf(image.transform, 8))) ApplyTitleStatic(true);
            string name;
            try { name = value.name ?? ""; } catch { return; }
            if (LoadingArt.IsLoadingTexture(name) || IsLoadingSpriteValue(value))
            {
                Sprite loading = LoadingArt.PickFor(image.GetInstanceID());
                if (loading != null) { value = loading; try { image.preserveAspect = false; } catch { } }
                return;
            }
            if (!IsBrandSprite(name)) return;
            if (IsLoadingLogoPath(PathOf(image.transform, 8)))
            {
                if (Time.realtimeSinceStartup >= 6f && titleSprite != null)
                {
                    value = titleSprite;
                    try { image.preserveAspect = true; } catch { }
                    BrandingPlugin.Trace.LogInfo("titre : logo REC BLUE applique (guard login).");
                }
                else KeepLoadingLogo();
                return;
            }
            if (IsBrandShadowSprite(name))
            {
                try { image.enabled = false; } catch { }
                value = null;
                return;
            }
            if (titleSprite == null) return;
            value = titleSprite;
            try { image.preserveAspect = true; } catch { }
        }

        // Appele a l'activation : couvre les sprites poses par les donnees du prefab.
        internal static void GuardExisting(Image image)
        {
            if (safeMode || image == null) return;
            EnsureDriverActive();
            RequestLateTintFromImage(image);
            TintBackgroundsForGraphic(image);
            if (Time.realtimeSinceStartup >= 6f) ApplyTitleStatic();
            if (IsLoginLogoPath(PathOf(image.transform, 8))) ApplyTitleStatic(true);
            Sprite current;
            try { current = image.sprite; } catch { return; }
            if (current == null) return;
            string name;
            try { name = current.name ?? ""; } catch { return; }
            if (LoadingArt.IsLoadingTexture(name) || IsLoadingSpriteValue(current))
            {
                Sprite loading = LoadingArt.PickFor(image.GetInstanceID());
                if (loading != null) { try { image.sprite = loading; image.preserveAspect = false; } catch { } }
                return;
            }
            if (!IsBrandSprite(name)) return;
            if (IsLoadingLogoPath(PathOf(image.transform, 8)))
            {
                if (Time.realtimeSinceStartup >= 6f && titleSprite != null)
                {
                    try { image.sprite = titleSprite; image.preserveAspect = true; } catch { }
                    BrandingPlugin.Trace.LogInfo("titre : logo REC BLUE applique (guard login).");
                }
                else KeepLoadingLogo();
                return;
            }
            if (IsBrandShadowSprite(name))
            {
                try { image.enabled = false; } catch { }
                return;
            }
            if (titleSprite == null) return;
            try { image.sprite = titleSprite; image.preserveAspect = true; } catch { }
        }

        private static bool IsLoadingSpriteValue(Sprite sprite)
        {
            if (sprite == null) return false;
            string name = "";
            try { name = sprite.name ?? ""; } catch { }
            if (LoadingArt.IsLoadingTexture(name)) return true;
            try
            {
                Texture2D texture = sprite.texture;
                if (texture != null && LoadingArt.IsLoadingTexture(texture.name ?? "")) return true;
            }
            catch { }
            return false;
        }

        internal static void GuardTexture(RawImage raw, ref Texture value)
        {
            if (safeMode || value == null) return;
            string name = "";
            try { name = value.name ?? ""; } catch { return; }
            if (!LoadingArt.IsLoadingTexture(name) && !IsLoadingBackground(raw)) return;
            Texture2D replacement = LoadingArt.TextureFor(raw.GetInstanceID());
            if (replacement == null) return;
            value = replacement;
            LoadingTarget = raw;
            try { raw.uvRect = new Rect(0f, 0f, 1f, 1f); } catch { }
        }

        private static bool IsLoadingBackground(RawImage raw)
        {
            if (!LoadingArt.Enabled) return false;
            try
            {
                string path = BrandingScan.PathOf(raw.transform, 8).ToLowerInvariant();
                if (!path.Contains("[loadingscreen]")) return false;
                Rect box = default(Rect);
                try { box = raw.rectTransform.rect; } catch { }
                return box.width >= 1200f && box.height >= 700f;
            }
            catch { return false; }
        }

        private static void ApplyLoading(Image image)
        {
            Sprite sprite = LoadingArt.PickFor(image.GetInstanceID());
            if (sprite == null) return;
            try { image.sprite = sprite; image.preserveAspect = false; } catch { }
        }

        private static bool IsBrandSprite(string name)
        {
            if (string.IsNullOrEmpty(name) || name == "RecBlueTitle") return false;
            foreach (string target in LogoSprites)
                if (name.StartsWith(target, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        // Le jeu reaffecte sa texture de chargement apres notre passe : on impose la notre
        // en fin de frame, juste avant le rendu, tant que l'ecran est affiche.
        private void LateUpdate()
        {
            if (safeMode) return;
            RawImage target = LoadingTarget;
            bool visible = target != null && target.isActiveAndEnabled;
            if (!visible)
            {
                if (target != null)
                {
                    if (loadingHiddenAt == 0f) loadingHiddenAt = Time.realtimeSinceStartup;
                    else if (Time.realtimeSinceStartup - loadingHiddenAt > 1f)
                    {
                        loadingHiddenAt = 0f;
                        LoadingArt.ResetCycle();
                    }
                }
                // L'ecran peut etre recree entre deux chargements : on le retrouve par son
                // nom, sinon le deuxieme chargement gardait la photo d'origine.
                if (Time.realtimeSinceStartup >= nextLoadingFind)
                {
                    nextLoadingFind = Time.realtimeSinceStartup + 0.5f;
                    target = FindLoadingBackground();
                    if (target != null) { LoadingTarget = target; visible = target.isActiveAndEnabled; }
                }
                if (!visible) return;
            }
            else loadingHiddenAt = 0f;
            try
            {
                Texture2D wanted = LoadingArt.TextureFor(target.GetInstanceID());
                if (wanted == null) return;
                if (target.texture != wanted)
                {
                    target.texture = wanted;
                    if (Time.realtimeSinceStartup >= nextLoadingLog)
                    {
                        nextLoadingLog = Time.realtimeSinceStartup + 5f;
                        BrandingPlugin.Trace.LogInfo("chargement : texture imposee (" + PathOf(target.transform, 6) + ").");
                    }
                }
            }
            catch { LoadingTarget = null; }
        }

        private static RawImage FindLoadingBackground()
        {
            if (!LoadingArt.Enabled) return null;
            try
            {
                foreach (RawImage image in UnityEngine.Object.FindObjectsOfType<RawImage>())
                {
                    if (image == null) continue;
                    string name = "";
                    try { if (image.texture != null) name = image.texture.name ?? ""; } catch { }
                    if (!LoadingArt.IsLoadingTexture(name) && !IsLoadingBackground(image)) continue;
                    BrandingPlugin.Trace.LogInfo("chargement : ecran retrouve a " + Mathf.RoundToInt(Time.realtimeSinceStartup) + " s.");
                    return image;
                }
            }
            catch { }
            return null;
        }

        private void Update()
        {
            try
            {
                // Sonde : chaque gel de frame est signale avec le travail du plugin qui l'a
                // precedee. Plafonnee a 40 lignes pour ne pas noyer le journal.

                if (!safeChecked)
                {
                    safeChecked = true;
                    safeMode = System.IO.File.Exists(SafeMarker);
                    if (safeMode)
                        BrandingPlugin.Trace.LogInfo("mode sans branding : titre, couleurs et textures laisses au jeu, transparence du Watch active (configuration fps conservee).");
                }
                ReadMode();
                try { BanAppealScanTick(Time.realtimeSinceStartup); } catch { }
                BrandingPlugin.EnsureYoutubeButton();
                BoardLinkPass(Time.realtimeSinceStartup);
                if (!safeMode && BrandingPlugin.EnableLogoBranding) Prepare();


                // Diagnostic A/B : si le marqueur existe, les passes s'arretent apres 45 s
                // mais la sonde de fps continue. On mesure ainsi le cout reel du plugin
                // dans la meme piece, au lieu de comparer deux ecrans differents.
                if (!idleFlagRead)
                {
                    idleFlagRead = true;
                    try { idleForced = System.IO.File.Exists("C:/RecRoom2023/BepInEx/plugins/RECBLUE_IDLE.txt"); } catch { }
                }
                if (idleForced && Time.realtimeSinceStartup - startedAt > 45f)
                {
                    if (!idleLogged)
                    {
                        idleLogged = true;
                    }
                    return;
                }

                float now = Time.realtimeSinceStartup;
                if (startedAt <= 0f) startedAt = now;
                // Tableau laisse d'origine : aucune repeinte globale.
                boardPaintRequested = true;
                // Des le chargement de la room (puis regulierement) pour que le tableau
                // soit deja bleu quand le joueur apparait, et le reste.
                if (!boardTexturesDone && now >= nextBoardTextureAt)
                {
                    nextBoardTextureAt = now + (now < 60f ? 5f : 30f);
                    float boardStart = Time.realtimeSinceStartup;
                    try { RecolourBoardTextures(); } catch { }
                    float boardMs = (Time.realtimeSinceStartup - boardStart) * 1000f;
                    if (boardMs > 20f) BrandingPlugin.Trace.LogInfo("tableau : passe " + Mathf.RoundToInt(boardMs) + " ms");
                }
                if (now > 30f && now >= nextWorldBoardAt)
                {
                    nextWorldBoardAt = now + (boardBlueTexture != null ? 30f : 2f);
                    float worldStart = Time.realtimeSinceStartup;
                    try { WorldBoardPass(); } catch { }
                    float worldMs = (Time.realtimeSinceStartup - worldStart) * 1000f;
                    if (worldMs > 20f) BrandingPlugin.Trace.LogInfo("monde : passe " + Mathf.RoundToInt(worldMs) + " ms");
                }
                if (lateTintAt > 0f && now >= lateTintAt)
                {
                    lateTintAt = 0f;
                    TintBackgrounds();
                }
                if (!safeMode && BrandingPlugin.EnableLogoBranding) ApplyTitleOnce(now);
                if (BrandingPlugin.EnableLoadingTitle) ApplyLoadingTitle(now);
                float age = now - startedAt;

                CheckCanaries(now);
                if (BrandingPlugin.EnableLogoBranding && BrandingPlugin.EnableLogoSweep) WatchLogoRoots(now);
                CheckSelection();
                AutoLoginForTest();
                TintWatchMenu(now);
                if (age < 8f) RequestPaint(2f);
                PaintSlice();
                if (BrandingPlugin.EnableDiagnostics)
                {
                    DumpLogoOnce(now);
                    DumpLoadingOnce(now);
                }


                if (!sceneHooked)
                {
                    // Pas d'abonnement a sceneLoaded : UnityAction n'est pas un delegue dans
                    // l'interop Il2Cpp. La variation du nombre de Canvas joue ce role et
                    // couvre aussi les panneaux qui s'ouvrent sans changer de scene.
                    sceneHooked = true;
                }

                // Sweep/TintPass enumerent tous les Graphic et Selectable vivants : couteux.
                // Tourner en boucle faisait saccader le jeu ; ne tourner qu'au demarrage
                // faisait perdre le bleu des ecrans tardifs. On tourne donc par salves.
                if (now >= nextCanvasCheck)
                {
                    nextCanvasCheck = now + 5f;
                    int canvases = 0;
                    try { canvases = FindObjectsOfType<Canvas>().Length; } catch { }
                    if (canvases != canvasSeen)
                    {
                        int jump = canvases - canvasSeen;
                        canvasSeen = canvases;
                        burstUntil = now + 8f;
                        // Nouveau panneau : on repeint tout de suite ses textes et on
                        // rafraichit la liste des Graphic sans attendre la passe de securite.
                        RequestPaint(4f);
                        nextGraphicsRefresh = 0f;
                        // Nouvel ecran : on relance la passe de logo sans attendre le balayage
                        // suivant (20 s), sinon le logo du jeu reste visible tout ce temps.
                        if (now - lastSweepAt >= 0.3f) nextSweep = now;
                        // On ne repousse plus la passe : chaque canvas qui apparait la repoussait
                        // de 1,5 s et le balayage n'etait jamais execute (titre jamais pose).
                        // Le plancher de 8 s entre deux passes suffit a eviter les rafales.
                        // On laisse le panneau finir de s'ouvrir avant de l'enumerer : sinon
                        // la sonde mesure 568 ms de gel pendant son animation.
                        nextEnqueue = now + 1.5f;
                    }
                }

                bool bursting = now < burstUntil && age < BrandWindow;
                // Le titre doit revenir meme si le logo n'apparait qu'apres la fenetre de 20 s
                // (constate sur le tableau : "titre REC BLUE introuvable"). Une fois les
                // premiers remplacements faits, la verification s'espace pour ne rien couter.
                // Une passe de logo commencee se poursuit a chaque frame, par tranches.
                if (BrandingPlugin.EnableLogoBranding && BrandingPlugin.EnableLogoSweep && sweepQueue != null) Sweep();

                // Au demarrage, un nouvel ecran doit etre traite tout de suite : le logo du
                // jeu ne doit pas rester affiche. Le plancher de 8 s ne revient qu'ensuite.
                float sweepFloor = age < 60f ? 0.4f : 8f;
                if (BrandingPlugin.EnableLogoBranding && BrandingPlugin.EnableLogoSweep && now >= nextSweep && now - lastSweepAt >= sweepFloor)
                {
                    System.Diagnostics.Stopwatch blockWatch = System.Diagnostics.Stopwatch.StartNew();
                    // Une passe enumere toutes les Image vivantes : six passes au demarrage ont
                    // ete mesurees a 2,3 s de gel. Minimum 8 s entre deux, puis 120 s.
                    lastSweepAt = now;
                    // Tant que le titre n'est pas pose on retente toutes les 20 s (le logo
                    // n'existe pas encore pendant le chargement) ; ensuite 120 s suffisent.
                    nextSweep = now + (age < 60f ? 0.5f : (sweeps > 9 ? 120f : 20f));
                    sweeps++;
                    Sweep();
                    // Nouvel ecran vu : on repeint ses textes et son tableau tout de suite.
                    RequestPaint(3f);
                    // Couche bleue desactivee : posee dans le mauvais canvas, elle passait
                    // devant le panneau et masquait tout l'ecran de login.
                    if (backdropObject != null)
                    {
                        try { Destroy(backdropObject); } catch { }
                        backdropObject = null;
                    }
                    if (loginAttempts < 5)
                    {
                        loginAttempts++;
                        MoveLanguageRow4();
                    }
                    // La palette RRUI est la source du bleu, mais sa conversion passe en
                    // reflection sur tous les assets : lancee a chaque salve (0,5 s apres un
                    // clic) elle provoquait les gels. Une fois toutes les 10 s suffit.
                    if (!safeMode && paintTextures && now >= nextPaletteAt && Time.unscaledDeltaTime < 0.04f)
                    {
                        nextPaletteAt = now + 60f;
                        palettePasses++;
                        try { PalettePass(); } catch { }
                    }
                    if (blockWatch.ElapsedMilliseconds >= 40)
                        BrandingPlugin.Trace.LogInfo("perf : bloc balayage " + blockWatch.ElapsedMilliseconds + " ms");
                }

                // La sonde mesure 568 ms pour une enumeration complete des Image : elle n'est
                // plus faite toutes les 2 s mais a l'ouverture d'un panneau (salve) et deux
                // fois au demarrage. Les textures deja converties restent en cache.
                if (!safeMode && paintTextures && age > StartDelay && now >= nextEnqueue && (bursting || enqueueRuns < 2))
                {
                    enqueueRuns++;
                    nextEnqueue = now + (bursting ? 10f : 30f);
                    Enqueue();
                }

                if (paintTextures)
                {
                    int before = texturesDone;
                    ProcessQueue();
                    if (texturesDone != before) nextRebind = now + 6.0f;
                }

                if (nextRebind > 0f && now >= nextRebind && queue.Count == 0)
                {
                    nextRebind = 0f;
                    RebindSprites();
                }

                if (now - startedAt > Window && queue.Count == 0 && !rebound)
                {
                    rebound = true;
                    RebindSprites();
                    BrandingPlugin.Trace.LogInfo("surveillance : veille active (salve a chaque changement d'ecran, passe de securite toutes les 30 s).");
                }
            }
            catch (Exception error) { BrandingPlugin.Trace.LogError(error); }
        }
    }
}
