// REC BLUE - launcher (application Windows autonome, aucun PowerShell a l execution).
//
// Reprise du launcher d origine avec l habillage et les animations du site :
//  - motif de marques cyan qui derive en diagonale (-24deg, 165 px, 6 s lineaire) ;
//  - deux halos de lumiere qui respirent (14 s, aller-retour) ;
//  - marque "REC BLUE" avec le relief du site (cyan + bleu profond) et son inclinaison.
//
// Compilation :
//   csc.exe -nologo -target:winexe -out:REC-BLUE-Launcher.exe -r:System.Windows.Forms.dll
//           -r:System.Drawing.dll -r:System.Management.dll RecBlueLauncher.cs
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

// Identite de l executable, et pas seulement du confort : un exe sans ressource de version
// (FileDescription / ProductName / CompanyName a vide, FileVersion 0.0.0.0) est un signal
// fort pour l heuristique de Windows Defender, qui l a classe Trojan:Win32/Bearfoos.A!ml et
// supprime le fichier. Ces attributs remplissent le VERSIONINFO que Windows lit.
[assembly: System.Reflection.AssemblyTitle("REC BLUE Launcher")]
[assembly: System.Reflection.AssemblyDescription("Installateur et launcher officiel REC BLUE pour Windows : detecte une installation Rec Room existante, ajoute le pack du serveur et lance le jeu.")]
[assembly: System.Reflection.AssemblyProduct("REC BLUE")]
[assembly: System.Reflection.AssemblyCompany("REC BLUE")]
[assembly: System.Reflection.AssemblyCopyright("Copyright (c) REC BLUE 2026")]
[assembly: System.Reflection.AssemblyVersion("2026.11.11.3")]
[assembly: System.Reflection.AssemblyFileVersion("2026.11.11.3")]
[assembly: System.Reflection.AssemblyInformationalVersion("2026.11.11.3")]
[assembly: System.Reflection.AssemblyCulture("")]

internal static class Launcher
{
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern bool AttachConsole(int processId);

    // Sondage de licence : on charge la DLL Steam du jeu dans un dossier temporaire et on
    // appelle son SteamAPI_Init. Mesure du 11/11/2026 : trois AppID non possedes par le
    // compte connecte font echouer l'initialisation, alors que 471710 reussit. C'est donc
    // le seul moyen de savoir, avant de lancer, si Steam reconnait une licence.
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibrary(string fileName);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Ansi, SetLastError = true)]
    private static extern IntPtr GetProcAddress(IntPtr module, string name);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern bool FreeLibrary(IntPtr module);
    [System.Runtime.InteropServices.UnmanagedFunctionPointer(System.Runtime.InteropServices.CallingConvention.Cdecl)]
    private delegate bool SteamInitCall();
    [System.Runtime.InteropServices.UnmanagedFunctionPointer(System.Runtime.InteropServices.CallingConvention.Cdecl)]
    private delegate void SteamShutdownCall();

    // Windows arrondit ses minuteries a 15,6 ms : sans cela le launcher ne peut pas depasser
    // ~64 images/s, et une image sur trois arrive en retard. Une milliseconde de resolution
    // suffit pour suivre les 60 a 240 Hz des ecrans.
    [System.Runtime.InteropServices.DllImport("winmm.dll")]
    private static extern int timeBeginPeriod(int milliseconds);

    [System.Runtime.InteropServices.DllImport("winmm.dll")]
    private static extern int timeEndPeriod(int milliseconds);

    // Frequence verticale du moniteur (GetDeviceCaps / VREFRESH). CreateDC vise
    // l ecran de la fenetre ; GetDC sert de secours sur les pilotes qui refusent
    // le nom de peripherique.
    private const int VREFRESH = 116;
    [System.Runtime.InteropServices.DllImport("gdi32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern IntPtr CreateDC(string lpszDriver, string lpszDevice, string lpszPort, IntPtr pdm);
    [System.Runtime.InteropServices.DllImport("gdi32.dll")]
    private static extern bool DeleteDC(IntPtr hdc);
    [System.Runtime.InteropServices.DllImport("gdi32.dll")]
    private static extern int GetDeviceCaps(IntPtr hdc, int nIndex);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hWnd);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    // ---- format de la fenetre ------------------------------------------------
    internal const int W = 960;
    internal const int WindowRadius = 22;   // rayon des coins de la fenetre
    internal const int H = 600;
    internal const int Cell = 165;          // pas du motif, comme le site (165 px)
    // Memes reglages que le site, au pixel pres : 165 px en 6 s (soit 27,5 px/s) pour le
    // motif et 14 s pour un aller des halos. Le launcher doit bouger comme la page.
    private const double PatternSpeed = Cell / 6.0;  // px/s : 165 px en 6 s, comme le site
    private const double LightCycle = 14.0;          // s pour un aller des halos (site : 14 s)

    private const int LogoBaseline1 = 178;  // ligne "REC" + marque (secours sans image)
    private const int LogoBaseline2 = 300;  // ligne "BLUE" (secours sans image)
    private const int SubBaseline = 290;    // sous-titre traduit
    private const int LogoCenterY = 232;    // centre du logo officiel (secours)
    // Abaisse la pastille de statut pour laisser passer le logo qui flotte
    // desormais de 7 px : le sous-titre ne doit jamais venir la couper.
    private const int StatusY = 318;
    private const int ButtonY = 360;
    private const int PillY = 464;

    // Palette de la maquette : creme, bleu nuit et couleurs des actions.
    internal static readonly Color Cream = Color.FromArgb(255, 255, 248, 231);

    // ---- etat ----------------------------------------------------------------
    internal static string GameDir;
    internal static string Exe;
    internal static string Backup;
    internal static string LogFile;
    internal static FontFamily LogoFamily;
    // Le jeu ne se lance plus tout seul au démarrage du launcher : c'est le joueur qui
    // clique sur Écran ou VR. Le drapeau reste (et `-NoAuto` continue de le poser), mais
    // il est vrai par défaut, donc aucun compte à rebours ne démarre jamais.
    internal static bool NoAuto = true;

    internal static bool Loading;
    internal static double Spin;
    internal static double Ox, Oy;
    internal static double Anim;
    internal static int Hover;
    internal static int Poll;
    internal static DateTime LaunchAt;

    // Ecran de chargement REC BLUE affiche au demarrage : les boutons arrivent apres.
    internal static bool Intro = true;
    internal static double IntroProgress;
    // Fondu enchaine vers le menu : 0 = intro, 1 = menu.
    internal static double IntroFade;
    internal static Bitmap IntroFadeBmp;
    internal static double MenuReveal = 1.0;
    private const double IntroFadeSeconds = 0.45;
    private const double MenuRevealSeconds = 0.28;
    internal static DateTime IntroAt = DateTime.Now;
    internal static double IntroStartAnim;
    internal static string Status = "Verification du serveur...";
    internal static string LoadText = "Chargement de Rec Room...";
    internal static bool AutoDone;
    internal static DateTime AutoAt = DateTime.MinValue;
    internal static bool AutoVr;
    internal static bool ServerChecked;
    internal static bool ServerOk;
    // Latence mesuree vers ns.recblue.net, affichee a cote de l'etat du serveur.
    internal static int ServerMs = -1;
    // Dernier texte ecrit pour l'etat du serveur : la relance periodique ne remplace
    // la ligne que si elle porte encore ce texte (et non un message d'installation).
    internal static string ServerStatusText = "";
    // Etat des plugins, relu dans le journal BepInEx pour confirmer leur chargement.
    internal static string PluginState = "";
    internal static DateTime PluginCheckedAt = DateTime.MinValue;
    // Diagnostic Steam, relu dans le journal du client pendant le chargement. Le client
    // nomme lui-meme son refus ; le launcher le traduit en une phrase utile.
    internal static string SteamDiagnosis = "";
    internal static DateTime SteamCheckedAt = DateTime.MinValue;

    internal static Bitmap BgBmp, PatBmp, LogoBmp, UiBmp;
    internal static Bitmap[] LogoPhaseBmp;
    private const int LogoPhases = 8;
    internal static Bitmap IntroTitle, IntroTitleCache;
    private static Bitmap[] PatPhaseBmp;

    // Le logo officiel du site, embarque dans l exe (aucun fichier a cote).
    internal static Bitmap LogoImage;

    private static void LoadLogoImage()
    {
        try
        {
            Stream stream = System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream("RecBlueLogo.png");
            if (stream == null) return;
            using (stream)
            {
                using (Bitmap loaded = new Bitmap(stream)) LogoImage = new Bitmap(loaded);
            }
        }
        catch { }
    }

    private static void LoadIntroTitle()
    {
        try
        {
            Stream stream = System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream("RecBlueTitleWinter.png");
            if (stream == null) return;
            using (stream)
            {
                using (Bitmap loaded = new Bitmap(stream)) IntroTitle = new Bitmap(loaded);
            }
        }
        catch { }
    }

    // Le titre source fait 1094x916 : le redimensionner a chaque image coutait
    // plusieurs millisecondes. On le pre-rend une fois a sa taille finale.
    private static void BuildIntroTitleCache(int windowWidth)
    {
        if (IntroTitle == null) return;
        int cacheW = (int)Math.Round(windowWidth * 0.44);
        int cacheH = (int)Math.Round(cacheW * (double)IntroTitle.Height / IntroTitle.Width);
        Bitmap cache = new Bitmap(cacheW, cacheH);
        using (Graphics cacheGraphics = Graphics.FromImage(cache))
        {
            cacheGraphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            cacheGraphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            cacheGraphics.DrawImage(IntroTitle, 0, 0, cacheW, cacheH);
        }
        if (IntroTitleCache != null) IntroTitleCache.Dispose();
        IntroTitleCache = cache;
    }
    internal static Bitmap[] LightFrames;
    internal static int UiHoverKey = -1;
    internal static string UiStatus;
    internal static string UiPlugins;
    internal static string UiAccount;

    internal static Account Current;
    internal static string AccountLabel = "SE CONNECTER";

    // ---- langues -------------------------------------------------------------
    // Les dix langues du site, dans le meme ordre. Tout ce qui s affiche passe par T().
    internal static readonly string[] LangCodes = new string[] { "fr", "en", "es", "ru", "de", "ar", "zh", "it", "ro", "hu" };
    internal static readonly string[] LangNames = new string[] { "Français", "English", "Español", "Русский", "Deutsch", "العربية", "中文", "Italiano", "Română", "Magyar" };
    internal static string Lang = "fr";

    // Cadence du launcher : AUTO suit la frequence de l ecran, ou un choix fixe
    // 60 / 120 / 240 i/s. Le selecteur FPS en haut a droite la fige dans la config.
    private static volatile int FpsLimit = 60;
    private static bool FpsManual;

    internal static string T(string fr, string en, string es, string ru, string de, string ar, string zh, string it, string ro, string hu)
    {
        switch (Lang)
        {
            case "en": return en;
            case "es": return es;
            case "ru": return ru;
            case "de": return de;
            case "ar": return ar;
            case "zh": return zh;
            case "it": return it;
            case "ro": return ro;
            case "hu": return hu;
            default: return fr;
        }
    }

    // Le launcher n'a pas besoin de traduire les messages de maintenance dans les
    // dix langues : le français et l'anglais suffisent, l'anglais sert de secours.
    internal static string MaintText(string fr, string en)
    {
        return T(fr, en, en, en, en, en, en, en, en, en);
    }

    internal static bool IsKnownLang(string code)
    {
        for (int i = 0; i < LangCodes.Length; i++) if (LangCodes[i] == code) return true;
        return false;
    }

    internal static int LangIndex
    {
        get
        {
            for (int i = 0; i < LangCodes.Length; i++) if (LangCodes[i] == Lang) return i;
            return 0;
        }
    }

    // Segoe UI couvre le latin, le cyrillique et l arabe ; le chinois demande YaHei.
    internal static string UiFamily
    {
        get { return Lang == "zh" ? "Microsoft YaHei" : "Segoe UI"; }
    }

    // La police du site n a que le latin : les boutons en russe, arabe ou chinois
    // passeraient en carres vides, donc ils prennent la police systeme.
    internal static string DisplayFamily
    {
        get
        {
            if (Lang == "ru" || Lang == "ar" || Lang == "zh") return UiFamily;
            return LogoFamily == null ? "Segoe UI" : LogoFamily.Name;
        }
    }

    internal static Font UiFont(float size, FontStyle style)
    {
        return new Font(UiFamily, size, style);
    }

    internal static void ResetStatus()
    {
        Status = T("Verification du serveur...", "Checking the server...", "Comprobando el servidor...", "Проверка сервера...", "Server wird geprüft...", "جارٍ التحقق من الخادم...", "正在检查服务器...", "Verifica del server...", "Se verifică serverul...", "Szerver ellenőrzése...");
        LoadText = T("Chargement de Rec Room...", "Loading Rec Room...", "Cargando Rec Room...", "Загрузка Rec Room...", "Rec Room wird geladen...", "جارٍ تحميل Rec Room...", "正在加载 Rec Room...", "Caricamento di Rec Room...", "Se încarcă Rec Room...", "Rec Room betöltése...");
    }

    internal static void ApplyLanguage()
    {
        if (LogoBmp != null) { LogoBmp.Dispose(); LogoBmp = null; }
        LogoBmp = BuildLogo(W, H);
        UpdateAccountLabel();
        ResetStatus();
        UiHoverKey = -2;
        WriteLog("langue : " + Lang);
    }

    private static readonly Stopwatch Clock = Stopwatch.StartNew();
    private static double LastTick;
    // Horloge 60 Hz haute resolution : un thread dedie poste les frames UI.
    private static volatile bool FrameClockRunning;
    private static int FramePosted;

    internal sealed class Account
    {
        public string Pseudo = "";
        public string Role = "";
        // Jeton Supabase : il permet au serveur de vérifier le rôle admin au lancement.
        public string Access = "";
        public string Refresh = "";
    }

    // ---- fichiers attendus ---------------------------------------------------
    internal struct RequiredFile
    {
        public string Path;
        public long Min;
        public RequiredFile(string path, long min) { Path = path; Min = min; }
    }

    // Une installation du jeu se reconnait a ses fichiers, jamais a un marqueur Steam :
    // ils viennent d'une copie locale existante, ou sont poses par le launcher quand le
    // joueur n'a plus rien (voir GameArchiveUrl). Le pack, lui, est ajoute dans le
    // dossier du jeu.
    private static readonly RequiredFile[] GameRequired = new RequiredFile[]
    {
        new RequiredFile("RecRoom.exe", 500 * 1024),
        new RequiredFile("GameAssembly.dll", 100L * 1024 * 1024),
        new RequiredFile("UnityPlayer.dll", 20L * 1024 * 1024),
        new RequiredFile(@"RecRoom_Data\globalgamemanagers", 1024 * 1024),
        new RequiredFile(@"RecRoom_Data\Plugins\x86_64\steam_api64.dll", 100 * 1024)
    };

    private static readonly RequiredFile[] PackRequired = new RequiredFile[]
    {
        new RequiredFile("winhttp.dll", 10 * 1024),
        new RequiredFile("doorstop_config.ini", 500),
        new RequiredFile(@"BepInEx\core\BepInEx.Core.dll", 10 * 1024),
        new RequiredFile(@"BepInEx\plugins\RecNetPlugin.dll", 20 * 1024),
        new RequiredFile(@"BepInEx\config\net.rec.plugin.cfg", 500)
    };

    // ---- profils -------------------------------------------------------------
    // Le profil 2023 reste celui par defaut, au comportement inchange. Le profil 2025
    // est une installation entierement separee : autre executable, autre pack
    // (injecteur, pas BepInEx), autre configuration et autre fichier de reglages.
    // Rien ici ne modifie le pack 2023 : ses tableaux et son manifeste sont intacts.
    private static readonly RequiredFile[] GameRequired2025 = new RequiredFile[]
    {
        new RequiredFile("Recroom_Release.exe", 500 * 1024),
        new RequiredFile("GameAssembly.dll", 100L * 1024 * 1024),
        new RequiredFile("UnityPlayer.dll", 20L * 1024 * 1024),
        new RequiredFile(@"RecRoom_Data\globalgamemanagers", 1024 * 1024),
        new RequiredFile("Referee.dll", 100 * 1024),
        new RequiredFile(@"RecRoom_Data\Plugins\x86_64\steam_api64.dll", 100 * 1024)
    };

    private static readonly RequiredFile[] PackRequired2025 = new RequiredFile[]
    {
        new RequiredFile("2025Patch.dll", 100 * 1024),
        new RequiredFile("Injector.exe", 10 * 1024),
        new RequiredFile("2025patch.ini", 500),
        new RequiredFile("RecRoomScreen.bat", 100),
        new RequiredFile("RecRoomVR.bat", 100)
    };

    internal sealed class Profile
    {
        public string Id;
        public string DefaultGameDir;
        public string ExeName;
        public string ProcessName;
        public string PackUrl;
        public string ConfigRelative;
        public string ConfigNeedle;
        public string ServerHost;
        public bool Injector;
        public bool ScanSteam;
        public RequiredFile[] GameFiles;
        public RequiredFile[] PackFiles;
    }

    private static Profile BuildProfile2023()
    {
        return new Profile
        {
            Id = "2023",
            DefaultGameDir = "",
            ExeName = "RecRoom.exe",
            ProcessName = "RecRoom",
            PackUrl = DefaultPackUrl,
            ConfigRelative = @"BepInEx\config\net.rec.plugin.cfg",
            ConfigNeedle = "ns.recblue",
            ServerHost = "ns.recblue.net",
            Injector = false,
            ScanSteam = true,
            GameFiles = GameRequired,
            PackFiles = PackRequired
        };
    }

    private static Profile BuildProfile2025()
    {
        return new Profile
        {
            Id = "2025",
            DefaultGameDir = @"C:\RecRoom2025",
            ExeName = "Recroom_Release.exe",
            ProcessName = "Recroom_Release",
            PackUrl = "https://recblue.net/download/rec-blue-pack-2025.json",
            ConfigRelative = "2025patch.ini",
            ConfigNeedle = "ns.recblue",
            ServerHost = "ns.recblue.net",
            Injector = true,
            // Une copie 2025 vit hors de Steam : le marqueur appmanifest n'existe pas.
            ScanSteam = false,
            GameFiles = GameRequired2025,
            PackFiles = PackRequired2025
        };
    }

    private static readonly Profile Profile2023 = BuildProfile2023();
    private static readonly Profile Profile2025 = BuildProfile2025();
    private static Profile Selected = Profile2023;

    private static List<string> ProblemsFor(string dir, RequiredFile[] files)
    {
        List<string> problems = new List<string>();
        if (string.IsNullOrEmpty(dir))
        {
            problems.Add("MANQUANT : dossier du jeu");
            return problems;
        }
        for (int i = 0; i < files.Length; i++)
        {
            RequiredFile required = files[i];
            string full = Path.Combine(dir, required.Path);
            if (!File.Exists(full))
            {
                problems.Add("MANQUANT : " + required.Path);
                continue;
            }
            long length = new FileInfo(full).Length;
            if (length < required.Min)
            {
                problems.Add("ABIME    : " + required.Path + " (" + length + " octets)");
            }
        }
        return problems;
    }

    private static List<string> GetProblems()
    {
        List<string> problems = ProblemsFor(GameDir, Selected.GameFiles);
        problems.AddRange(ProblemsFor(GameDir, Selected.PackFiles));
        string config = Path.Combine(GameDir, Selected.ConfigRelative);
        if (!string.IsNullOrEmpty(GameDir) && File.Exists(config))
        {
            string text = SafeRead(config);
            if (text.IndexOf(Selected.ConfigNeedle, StringComparison.OrdinalIgnoreCase) < 0)
            {
                problems.Add("CONFIG   : adresse du serveur absente");
            }
        }
        return problems;
    }

    private static string SafeRead(string path)
    {
        try { return File.ReadAllText(path); }
        catch { return ""; }
    }

    internal static void WriteLog(string text)
    {
        try
        {
            File.AppendAllText(LogFile, DateTime.Now.ToString("s", CultureInfo.InvariantCulture) + "  " + text + Environment.NewLine);
        }
        catch { }
    }

    // ---- reparation ----------------------------------------------------------
    private static bool RestoreItem(string from, string to)
    {
        string source = Path.Combine(Backup, from);
        string target = Path.Combine(GameDir, to);
        if (!File.Exists(source) && !Directory.Exists(source)) return false;
        try
        {
            if (Directory.Exists(source))
            {
                Directory.CreateDirectory(target);
                CopyTree(source, target);
            }
            else
            {
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                File.Copy(source, target, true);
            }
            return true;
        }
        catch { return false; }
    }

    private static void CopyTree(string from, string to)
    {
        foreach (string file in Directory.GetFiles(from))
        {
            File.Copy(file, Path.Combine(to, Path.GetFileName(file)), true);
        }
        foreach (string dir in Directory.GetDirectories(from))
        {
            string next = Path.Combine(to, Path.GetFileName(dir));
            Directory.CreateDirectory(next);
            CopyTree(dir, next);
        }
    }

    private static List<string> RepairGame()
    {
        List<string> log = new List<string>();
        if (!Directory.Exists(Backup))
        {
            log.Add("Aucune sauvegarde de reference : " + Backup);
            return log;
        }
        if (Selected.Injector)
        {
            for (int i = 0; i < Selected.PackFiles.Length; i++)
            {
                string relative = Selected.PackFiles[i].Path;
                if (RestoreItem(relative, relative)) log.Add("RESTAURE : " + relative);
                else log.Add("ABSENT DE LA SAUVEGARDE : " + relative);
            }
            List<string> repairProblems = GetProblems();
            if (repairProblems.Count == 0) log.Add("TOUT EST OK");
            else log.AddRange(repairProblems);
            return log;
        }
        string[,] items = new string[,]
        {
            { "core", @"BepInEx\core" },
            { "plugins", @"BepInEx\plugins" },
            { "config", @"BepInEx\config" },
            { "doorstop_config.ini", "doorstop_config.ini" },
            { "winhttp.dll", "winhttp.dll" }
        };
        for (int i = 0; i < items.GetLength(0); i++)
        {
            if (RestoreItem(items[i, 0], items[i, 1])) log.Add("RESTAURE : " + items[i, 1]);
            else log.Add("ABSENT DE LA SAUVEGARDE : " + items[i, 0]);
        }
        List<string> problems = GetProblems();
        if (problems.Count == 0) log.Add("TOUT EST OK");
        else log.AddRange(problems);
        return log;
    }

    // Le zip fourni est ouvert par la commande qui sait le faire sans reference ajoutee.
    private static void UnzipInto(string zip, string target)
    {
        ProcessStartInfo info = new ProcessStartInfo("powershell.exe",
            "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command \"Expand-Archive -LiteralPath '" + zip.Replace("'", "''") +
            "' -DestinationPath '" + target.Replace("'", "''") + "' -Force\"");
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        using (Process process = Process.Start(info)) { process.WaitForExit(); }
    }

    // ---- VR et installations Steam -------------------------------------------
    private static List<string> SteamRoots()
    {
        List<string> roots = new List<string>();
        AddSteamRoot(roots, @"Software\Valve\Steam", "SteamPath", Microsoft.Win32.Registry.CurrentUser);
        AddSteamRoot(roots, @"SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath", Microsoft.Win32.Registry.LocalMachine);
        roots.Add(@"C:\Program Files (x86)\Steam");
        roots.Add(@"C:\Program Files\Steam");
        foreach (string root in new List<string>(roots))
        {
            string vdf = Path.Combine(root, @"steamapps\libraryfolders.vdf");
            if (!File.Exists(vdf)) continue;
            string raw = SafeRead(vdf);
            foreach (Match match in Regex.Matches(raw, "\"path\"\\s+\"([^\"]+)\""))
            {
                roots.Add(match.Groups[1].Value.Replace("\\\\", "\\"));
            }
        }

        // Les bibliotheques peuvent etre citees deux fois (registre + VDF) : on dedouble.
        List<string> unique = new List<string>();
        for (int i = 0; i < roots.Count; i++)
        {
            if (string.IsNullOrEmpty(roots[i])) continue;
            string full;
            try { full = Path.GetFullPath(roots[i].Replace('/', '\\')); }
            catch { continue; }
            bool seen = false;
            for (int j = 0; j < unique.Count; j++)
            {
                if (unique[j].Equals(full, StringComparison.OrdinalIgnoreCase)) { seen = true; break; }
            }
            if (!seen) unique.Add(full);
        }
        return unique;
    }

    private static string FindSteamVr()
    {
        foreach (string root in SteamRoots())
        {
            string[] relatives = new string[]
            {
                @"steamapps\common\SteamVR\bin\win64\vrstartup.exe",
                @"steamapps\common\SteamVR\bin\win32\vrstartup.exe"
            };
            for (int i = 0; i < relatives.Length; i++)
            {
                string candidate = Path.Combine(root, relatives[i]);
                if (File.Exists(candidate)) return candidate;
            }
        }
        return "";
    }

    // Une installation Rec Room valide : les fichiers du jeu sont la, et eux seuls en
    // temoignent. Aucun marqueur Steam n'est exige — le jeu a ete retire du Steam Store
    // le 2 juin 2026, et une copie gardee, deplacee ou installee sur un autre disque n'a
    // plus forcement steam_appid.txt ni appmanifest_471710.acf. Exiger ce marqueur en
    // plus refusait des copies parfaitement valides. Les fichiers attendus
    // (GameAssembly, UnityPlayer, globalgamemanagers, steam_api64) identifient deja
    // l'installation du jeu officiel, et le profil 2025 (copie hors Steam) n'a jamais
    // eu besoin d'autre chose.
    internal static bool IsGameFolder(string dir)
    {
        if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) return false;
        return ProblemsFor(dir, Selected.GameFiles).Count == 0;
    }

    // Rec Room peut etre dans n importe quelle bibliotheque Steam, y compris sur un
    // autre disque. On interroge le registre, libraryfolders.vdf et les emplacements
    // par defaut ; on ne copie jamais le jeu, on retient seulement son dossier.
    internal static List<string> FindGameInstalls()
    {
        List<string> found = new List<string>();
        AddGameInstall(found, GameDir);
        AddGameInstall(found, Path.GetDirectoryName(Application.ExecutablePath));
        if (Selected.DefaultGameDir != "") AddGameInstall(found, Selected.DefaultGameDir);
        // Balayer les bibliotheques Steam pour le profil 2025 ferait tomber sur la
        // meme installation que le profil 2023 : il reste sur son dossier dedie.
        if (!Selected.ScanSteam) return found;
        foreach (string root in SteamRoots())
        {
            AddGameInstall(found, Path.Combine(root, @"steamapps\common\Rec Room"));
            AddGameInstall(found, Path.Combine(root, @"steamapps\common\RecRoom"));
            string common = Path.Combine(root, @"steamapps\common");
            try
            {
                if (!Directory.Exists(common)) continue;
                string[] dirs = Directory.GetDirectories(common);
                for (int i = 0; i < dirs.Length; i++)
                {
                    if (Path.GetFileName(dirs[i]).IndexOf("Rec Room", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        AddGameInstall(found, dirs[i]);
                    }
                }
            }
            catch { }
        }
        return found;
    }

    internal static string FindGameInstall()
    {
        List<string> found = FindGameInstalls();
        return found.Count > 0 ? found[0] : "";
    }

    private static void AddGameInstall(List<string> found, string dir)
    {
        if (string.IsNullOrEmpty(dir)) return;
        string full;
        try { full = Path.GetFullPath(dir); }
        catch { return; }
        for (int i = 0; i < found.Count; i++)
        {
            if (found[i].Equals(full, StringComparison.OrdinalIgnoreCase)) return;
        }
        if (IsGameFolder(full)) found.Add(full);
    }

    private static void AddSteamRoot(List<string> roots, string key, string value, Microsoft.Win32.RegistryKey hive)
    {
        try
        {
            using (Microsoft.Win32.RegistryKey opened = hive.OpenSubKey(key))
            {
                if (opened == null) return;
                object found = opened.GetValue(value);
                object install = opened.GetValue("InstallPath");
                string candidate = found as string;
                if (string.IsNullOrEmpty(candidate)) candidate = install as string;
                if (!string.IsNullOrEmpty(candidate)) roots.Add(candidate.Replace('/', '\\'));
            }
        }
        catch { }
    }

    // Un casque doit etre vu par Windows avant que le client puisse en obtenir un : SteamVR
    // sans casque repond VRInitError_Init_HmdNotFound et le client se ferme tout seul.
    internal static bool TestVrHeadset()
    {
        try
        {
            using (System.Management.ManagementObjectSearcher searcher =
                new System.Management.ManagementObjectSearcher("SELECT Name FROM Win32_PnPEntity WHERE Name IS NOT NULL"))
            {
                foreach (System.Management.ManagementObject device in searcher.Get())
                {
                    string name = Convert.ToString(device["Name"]);
                    if (Regex.IsMatch(name, "Oculus|Rift|Quest|Valve|Index|Vive|HTC|Mixed Reality|Reverb|Pico|Varjo|HMD", RegexOptions.IgnoreCase))
                    {
                        return true;
                    }
                }
            }
        }
        catch { }
        return false;
    }

    private static bool TestOculusRuntime()
    {
        string[] names = new string[] { "OVRServer_x64", "OVRServiceLauncher", "oculus-platform-runtime" };
        for (int i = 0; i < names.Length; i++)
        {
            if (Process.GetProcessesByName(names[i]).Length > 0) return true;
        }
        string[] paths = new string[]
        {
            @"C:\Program Files\Meta Horizon\Support\oculus-runtime\OVRServer_x64.exe",
            @"C:\Program Files\Oculus\Support\oculus-runtime\OVRServer_x64.exe"
        };
        for (int i = 0; i < paths.Length; i++)
        {
            if (File.Exists(paths[i])) return true;
        }
        return false;
    }

    private static bool StopSteamVrProcesses()
    {
        bool stopped = false;
        string[] names = new string[] { "vrmonitor", "vrserver", "vrstartup" };
        for (int i = 0; i < names.Length; i++)
        {
            foreach (Process process in Process.GetProcessesByName(names[i]))
            {
                try { process.Kill(); stopped = true; }
                catch { }
            }
        }
        return stopped;
    }

    private static void StopSteamVrWithoutHeadset()
    {
        if (TestVrHeadset()) return;
        if (StopSteamVrProcesses()) WriteLog("SteamVR ferme : aucun casque detecte (sinon le jeu se ferme tout seul)");
    }

    private static bool GameRunning()
    {
        return Process.GetProcessesByName(Selected.ProcessName).Length > 0;
    }

    // ---- maintenance ---------------------------------------------------------
    // Vérifiée au moment du lancement : l'admin connecté passe par son jeton, les
    // autres doivent saisir le code d'été. Si le statut est injoignable, on laisse
    // jouer (le launcher reste utilisable hors ligne).
    private static bool MaintenanceAllowsLaunch()
    {
        string statusBody;
        int status;
        try
        {
            statusBody = HttpJson("https://recblue.net/api/maintenance/status", "GET", null, "", 6000, out status);
        }
        catch (Exception failure)
        {
            WriteLog("maintenance : statut indisponible (" + failure.Message + "), lancement autorise");
            return true;
        }
        if (status != 200)
        {
            WriteLog("maintenance : statut " + status + ", lancement autorise");
            return true;
        }
        if (!JsonBool(statusBody, "active")) return true;

        string message = JsonString(statusBody, "message");
        if (message == "") message = MaintText("Le jeu est en maintenance. Entre le code d’acces pour jouer.", "The game is under maintenance. Enter the access code to play.");

        string error = "";
        if (MaintenanceAccess("", out error)) return true;
        error = "";
        while (true)
        {
            using (MaintenanceDialog dialog = new MaintenanceDialog(message, error))
            {
                if (dialog.ShowDialog() != DialogResult.OK)
                {
                    Status = MaintText("Maintenance du jeu : acces annule.", "Game maintenance: access cancelled.");
                    WriteLog(Status);
                    return false;
                }
                if (MaintenanceAccess(dialog.Code, out error)) return true;
            }
        }
    }

    private static bool MaintenanceAccess(string code, out string error)
    {
        error = "";
        try
        {
            string token = FreshAccessToken();
            int status;
            string response = HttpJson("https://recblue.net/api/maintenance/access", "POST",
                "{\"code\":\"" + Escape(code) + "\"}", token, 8000, out status);
            if (JsonBool(response, "allowed")) return true;
            error = code == ""
                ? MaintText("Le jeu est en maintenance. Entre le code d’acces.", "The game is under maintenance. Enter the access code.")
                : MaintText("Code d’acces incorrect.", "Incorrect access code.");
            return false;
        }
        catch (Exception failure)
        {
            error = MaintText("Serveur de maintenance injoignable.", "Maintenance server unreachable.");
            WriteLog("maintenance : " + failure.Message);
            return false;
        }
    }

    private static string FreshAccessToken()
    {
        if (Current == null) return "";
        if (!string.IsNullOrEmpty(Current.Refresh))
        {
            try
            {
                string json = PostJson(SbUrl + "/auth/v1/token?grant_type=refresh_token",
                    "{\"refresh_token\":\"" + Escape(Current.Refresh) + "\"}");
                string access = JsonString(json, "access_token");
                string refresh = JsonString(json, "refresh_token");
                if (access != "")
                {
                    Current.Access = access;
                    if (refresh != "") Current.Refresh = refresh;
                    SaveAccount();
                    return access;
                }
            }
            catch (Exception failure) { WriteLog("maintenance : jeton non rafraichi (" + failure.Message + ")"); }
        }
        return Current.Access;
    }

    private static string HttpJson(string url, string method, string body, string bearer, int timeoutMs, out int status)
    {
        status = 0;
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
        request.Method = method;
        request.ContentType = "application/json";
        request.Timeout = timeoutMs;
        request.ReadWriteTimeout = timeoutMs;
        if (!string.IsNullOrEmpty(bearer)) request.Headers.Add("Authorization", "Bearer " + bearer);
        if (body != null)
        {
            byte[] payload = Encoding.UTF8.GetBytes(body);
            request.ContentLength = payload.Length;
            using (Stream stream = request.GetRequestStream()) { stream.Write(payload, 0, payload.Length); }
        }
        try
        {
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                status = (int)response.StatusCode;
                return reader.ReadToEnd();
            }
        }
        catch (WebException failure)
        {
            HttpWebResponse response = failure.Response as HttpWebResponse;
            if (response == null) throw;
            using (response)
            using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                status = (int)response.StatusCode;
                return reader.ReadToEnd();
            }
        }
    }

    private static bool JsonBool(string json, string key)
    {
        if (string.IsNullOrEmpty(json)) return false;
        Match match = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(true|false)");
        return match.Success && match.Groups[1].Value == "true";
    }

    // ---- lancement -----------------------------------------------------------
    internal static void StartGame(bool vr)
    {
        AutoAt = DateTime.MinValue;
        AutoDone = true;

        if (GameRunning())
        {
            Status = T("Rec Room tourne deja - ferme-le avant de relancer.", "Rec Room is already running - close it before restarting.", "Rec Room ya está abierto: ciérralo antes de volver a lanzarlo.", "Rec Room уже запущен — закройте его перед новым запуском.", "Rec Room läuft bereits – schließe es vor dem Neustart.", "Rec Room يعمل بالفعل - أغلقه قبل إعادة التشغيل.", "Rec Room 已在运行，请关闭后再启动。", "Rec Room è già in esecuzione: chiudilo prima di rilanciare.", "Rec Room rulează deja - închide-l înainte de a reporni.", "A Rec Room már fut – zárd be, mielőtt újraindítod.");
            WriteLog(Status);
            return;
        }
        if (!IsGameFolder(GameDir))
        {
            Status = T("Rec Room introuvable - clique sur INSTALLER.", "Rec Room not found - click INSTALL.", "Rec Room no encontrado: pulsa INSTALAR.", "Rec Room не найден — нажмите «УСТАНОВИТЬ».", "Rec Room nicht gefunden – klicke auf INSTALLIEREN.", "لم يتم العثور على Rec Room - اضغط تثبيت.", "未找到 Rec Room，请点击安装。", "Rec Room non trovato: premi INSTALLA.", "Rec Room nu a fost găsit - apasă INSTALEAZĂ.", "A Rec Room nem található – kattints a TELEPÍTÉS-re.");
            WriteLog(Status + " : " + GameDir);
            return;
        }

        List<string> problems = GetProblems();
        if (problems.Count > 0 && IsGameFolder(GameDir))
        {
            // Rien a installer a la main : le launcher telecharge le pack manquant puis
            // enchaine directement sur le lancement du jeu.
            LaunchAfterInstall = true;
            Status = T("Installation automatique du pack...", "Installing the pack automatically...", "Instalando el paquete automáticamente...", "Автоматическая установка пакета...", "Paket wird automatisch installiert...", "تثبيت الحزمة تلقائياً...", "正在自动安装包...", "Installazione automatica del pacchetto...", "Instalare automată a pachetului...", "A csomag automatikus telepítése...");
            WriteLog(Status);
            InstallPack(null, true);
            return;
        }
        if (problems.Count > 0)
        {
            Status = T("Pack REC BLUE incomplet - clique sur INSTALLER.", "REC BLUE pack incomplete - click INSTALL.", "Pack REC BLUE incompleto: pulsa INSTALAR.", "Пакет REC BLUE неполный — нажмите «УСТАНОВИТЬ».", "REC BLUE-Paket unvollständig – klicke auf INSTALLIEREN.", "حزمة REC BLUE غير مكتملة - اضغط تثبيت.", "REC BLUE 包不完整，请点击安装。", "Pacchetto REC BLUE incompleto: premi INSTALLA.", "Pachetul REC BLUE este incomplet - apasă INSTALEAZĂ.", "A REC BLUE csomag hiányos – kattints a TELEPÍTÉS-re.");
            WriteLog(string.Join(" | ", problems.ToArray()));
            return;
        }

        foreach (string problem in GetProblems()) WriteLog("probleme: " + problem);

        if (!MaintenanceAllowsLaunch()) return;

        if (vr)
        {
            if (!TestVrHeadset())
            {
                Status = T("Aucun casque VR detecte : branche-le, puis reclique (ou JOUER en mode ecran).", "No VR headset detected: plug it in, then click again (or PLAY in screen mode).", "No se detecta casco VR: conéctalo y vuelve a pulsar (o JUGAR en pantalla).", "Гарнитура VR не найдена: подключите её и нажмите снова (или ИГРАТЬ на экране).", "Kein VR-Headset erkannt: anschließen und erneut klicken (oder SPIELEN am Bildschirm).", "لم يتم اكتشاف نظارة VR: وصّلها ثم اضغط مجدداً (أو العب على الشاشة).", "未检测到 VR 头显：请连接后重试（或在屏幕上开始游戏）。", "Nessun visore VR rilevato: collegalo e riprova (o GIOCA su schermo).", "Nu s-a detectat cască VR: conecteaz-o și apasă din nou (sau JOACĂ pe ecran).", "Nem található VR-szemüveg: csatlakoztasd, majd kattints újra (vagy JÁTÉK képernyőn).");
                WriteLog(Status);
                return;
            }
            if (TestOculusRuntime()) WriteLog("Casque Meta detecte : SteamVR le pilote via son pilote oculus");
            string vrstart = FindSteamVr();
            if (vrstart == "")
            {
                Status = T("SteamVR introuvable : installe SteamVR dans Steam, puis reclique.", "SteamVR not found: install SteamVR from Steam, then click again.", "SteamVR no encontrado: instálalo desde Steam y vuelve a pulsar.", "SteamVR не найден: установите SteamVR в Steam и нажмите снова.", "SteamVR nicht gefunden: installiere SteamVR in Steam und klicke erneut.", "SteamVR غير موجود: ثبّته من Steam ثم اضغط مجدداً.", "未找到 SteamVR：请在 Steam 中安装后重试。", "SteamVR non trovato: installalo da Steam e riprova.", "SteamVR nu a fost găsit: instalează-l din Steam și apasă din nou.", "A SteamVR nem található: telepítsd a Steamből, majd kattints újra.");
                WriteLog(Status);
                return;
            }
            try
            {
                ProcessStartInfo start = new ProcessStartInfo(vrstart);
                start.WorkingDirectory = Path.GetDirectoryName(vrstart);
                start.UseShellExecute = true;
                Process.Start(start);
                WriteLog("SteamVR lance : " + vrstart);
                double waited = 0.0;
                while (waited < 20.0 &&
                       Process.GetProcessesByName("vrmonitor").Length == 0 &&
                       Process.GetProcessesByName("vrserver").Length == 0)
                {
                    Thread.Sleep(500);
                    waited += 0.5;
                }
                WriteLog("SteamVR pret apres " + ((int)waited) + " s");
            }
            catch (Exception error) { WriteLog("SteamVR : " + error.Message); }
        }

        if (!vr) StopSteamVrWithoutHeadset();

        LoadText = "Chargement de Rec Room...";
        if (vr)
        {
            Status = T("Lancement de Rec Room en VR...", "Launching Rec Room in VR...", "Iniciando Rec Room en VR...", "Запуск Rec Room в VR...", "Rec Room startet in VR...", "جارٍ تشغيل Rec Room بالواقع الافتراضي...", "正在以 VR 启动 Rec Room...", "Avvio di Rec Room in VR...", "Se lansează Rec Room în VR...", "Rec Room indítása VR-ben...");
            LoadText = T("Chargement de Rec Room (VR)...", "Loading Rec Room (VR)...", "Cargando Rec Room (VR)...", "Загрузка Rec Room (VR)...", "Rec Room wird geladen (VR)...", "جارٍ تحميل Rec Room (VR)...", "正在加载 Rec Room（VR）...", "Caricamento di Rec Room (VR)...", "Se încarcă Rec Room (VR)...", "Rec Room betöltése (VR)...");
        }
        else
        {
            Status = T("Lancement de Rec Room...", "Launching Rec Room...", "Iniciando Rec Room...", "Запуск Rec Room...", "Rec Room startet...", "جارٍ تشغيل Rec Room...", "正在启动 Rec Room...", "Avvio di Rec Room...", "Se lansează Rec Room...", "Rec Room indítása...");
        }
        WriteLog(Status);

        // Steam est indispensable et se verifie une seconde : le client appelle Steamworks
        // avant tout appel reseau. Mieux vaut le dire maintenant qu'apres une fenetre d'erreur.
        if (!SteamRunning())
        {
            string steam = SteamExePath();
            if (steam != "")
            {
                try { Process.Start(new ProcessStartInfo(steam) { UseShellExecute = true }); }
                catch { }
            }
            Status = T("Steam n'est pas lance : je l'ouvre, connecte-toi puis reclique sur JOUER.", "Steam is not running: I am opening it, sign in then click PLAY again.", "Steam no está abierto: lo abro, inicia sesión y vuelve a pulsar JUGAR.", "Steam не запущен: открываю его, войдите в аккаунт и нажмите ИГРАТЬ снова.", "Steam läuft nicht: ich öffne es, melde dich an und klicke erneut auf SPIELEN.", "Steam غير مشغّل: أفتحه الآن، سجّل الدخول ثم اضغط العب مرة أخرى.", "Steam 未运行：正在打开，请登录后再次点击开始游戏。", "Steam non è aperto: lo apro, accedi e premi di nuovo GIOCA.", "Steam nu rulează: îl deschid, autentifică-te și apasă din nou JOACĂ.", "A Steam nem fut: megnyitom, jelentkezz be, majd kattints újra a JÁTÉK-ra.");
            WriteLog(Status);
            return;
        }
        if (SteamOffline())
        {
            Status = T("Steam est en mode hors ligne : remets-le en ligne, sinon le jeu s'arrete a la connexion.", "Steam is in offline mode: go back online, otherwise the game stops at sign-in.", "Steam está en modo sin conexión: vuelve a conectarlo o el juego se detiene al iniciar sesión.", "Steam в автономном режиме: верните его в сеть, иначе игра остановится на входе.", "Steam ist im Offline-Modus: geh wieder online, sonst bricht das Spiel bei der Anmeldung ab.", "Steam في وضع عدم الاتصال: أعد الاتصال وإلا تتوقف اللعبة عند الدخول.", "Steam 处于离线模式：请恢复在线，否则游戏会在登录时停止。", "Steam è in modalità offline: torna online, altrimenti il gioco si ferma all'accesso.", "Steam este în modul offline: revino online, altfel jocul se oprește la autentificare.", "A Steam offline módban van: kapcsold vissza online, különben a játék a bejelentkezésnél leáll.");
            WriteLog(Status);
            return;
        }

        // Sonde de licence : sans elle, un compte sans Rec Room ne voit qu'une fenetre
        // d'erreur qui se ferme. Mesure du 11/11/2026 : la DLL Steam du jeu refuse de
        // s'initialiser pour un AppID absent de la bibliotheque du compte connecte.
        if (SteamLicenseMissing())
        {
            Status = SteamLicenseMessage();
            WriteLog(Status);
            return;
        }

        try
        {
            if (Selected.Injector)
            {
                // Le patch 2025 s'injecte apres le demarrage : Injector.exe attend le
                // client, puis le jeu est lance avec le mode demande. C'est exactement
                // le sequencement de RecRoomScreen.bat / RecRoomVR.bat.
                string injector = Path.Combine(GameDir, "Injector.exe");
                ProcessStartInfo wait = new ProcessStartInfo(injector);
                wait.WorkingDirectory = GameDir;
                wait.UseShellExecute = true;
                Process.Start(wait);
                Thread.Sleep(300);
            }
            ProcessStartInfo start = new ProcessStartInfo(Exe);
            start.WorkingDirectory = GameDir;
            start.UseShellExecute = true;
            if (Selected.Injector) start.Arguments = "+forcemode:" + (vr ? "vr" : "screen");
            Process.Start(start);
            Loading = true;
            Spin = 0.0;
            Poll = 0;
            LaunchAt = DateTime.Now;
            WriteLog("ecran de chargement affiche (" + (vr ? "VR" : "ecran") + ")");
        }
        catch (Exception error)
        {
            Status = T("Impossible de lancer le jeu : ", "Could not launch the game: ", "No se pudo iniciar el juego: ", "Не удалось запустить игру: ", "Spiel konnte nicht gestartet werden: ", "لم يتم تشغيل اللعبة: ", "无法启动游戏：", "Impossibile avviare il gioco: ", "Jocul nu a putut fi lansat: ", "A játék nem indítható el: ") + error.Message;
            WriteLog(Status);
        }
    }

    private static void PollLoading()
    {
        // Le client ecrit la cause exacte de son refus : on la lit pendant le chargement.
        string refusal = SteamRefusal();
        if (refusal != "")
        {
            WriteLog("diagnostic Steam : " + refusal);
            Loading = false;
            Status = refusal;
            return;
        }

        double elapsed = (DateTime.Now - LaunchAt).TotalSeconds;
        bool shown = false;
        foreach (Process process in Process.GetProcessesByName(Selected.ProcessName))
        {
            if (process.MainWindowHandle != IntPtr.Zero) { shown = true; break; }
        }
        if (shown)
        {
            WriteLog("fenetre du jeu affichee apres " + ((int)elapsed) + " s");
            Environment.Exit(0);
        }
        else if (!GameRunning() && elapsed > 15)
        {
            WriteLog("le jeu s est arrete pendant le chargement");
            Loading = false;
            Status = T("Le jeu s est ferme au demarrage - clique sur REPARER.", "The game closed on startup - click REPAIR.", "El juego se cerró al iniciar: pulsa REPARAR.", "Игра закрылась при запуске — нажмите ИСПРАВИТЬ.", "Das Spiel wurde beim Start beendet – klicke auf REPARIEREN.", "أُغلقت اللعبة عند التشغيل - اضغط إصلاح.", "游戏启动后关闭，请点击修复。", "Il gioco si è chiuso all'avvio: premi RIPARA.", "Jocul s-a închis la pornire - apasă REPARĂ.", "A játék bezárult indításkor – kattints a JAVÍTÁS-ra.");
        }
        else if (elapsed > 240)
        {
            WriteLog("delai de chargement depasse");
            Loading = false;
            Status = T("Chargement trop long - verifie REC-BLUE-Launcher.log.", "Loading takes too long - check REC-BLUE-Launcher.log.", "La carga tarda demasiado: revisa REC-BLUE-Launcher.log.", "Загрузка слишком долгая — проверьте REC-BLUE-Launcher.log.", "Laden dauert zu lange – prüfe REC-BLUE-Launcher.log.", "التحميل يستغرق وقتاً طويلاً - راجع REC-BLUE-Launcher.log.", "加载时间过长，请查看 REC-BLUE-Launcher.log。", "Caricamento troppo lungo: controlla REC-BLUE-Launcher.log.", "Încărcarea durează prea mult - verifică REC-BLUE-Launcher.log.", "A betöltés túl sokáig tart – nézd meg a REC-BLUE-Launcher.log fájlt.");
        }
    }

    // ---- compte REC BLUE -----------------------------------------------------
    private const string SbUrl = "https://nnftdqrbagynbblthkfg.supabase.co";
    private const string SbKey =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5uZnRkcXJiYWd5bmJibHRoa2ZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM3MDA5OTEsImV4cCI6MjEwOTI3Njk5MX0.JHTNOWkI9DY1xhU8PKco4KqxsIxp_-IsSZL211NGEE8";
    private const string PseudoDomain = "players.recblue.invalid";

    internal static string AccountFile
    {
        get { return Path.Combine(GameDir, "REC-BLUE-Compte.json"); }
    }

    internal static void UpdateAccountLabel()
    {
        if (Current == null)
        {
            AccountLabel = T("SE CONNECTER", "LOG IN", "INICIAR SESIÓN", "ВОЙТИ", "ANMELDEN", "تسجيل الدخول", "登录", "ACCEDI", "AUTENTIFICARE", "BEJELENTKEZÉS");
        }
        else
        {
            string role = Current.Role;
            if (role == "admin") role = T("admin", "admin", "admin", "админ", "Admin", "مدير", "管理员", "admin", "admin", "admin");
            else if (role == "moderator") role = T("moderateur", "moderator", "moderador", "модератор", "Moderator", "مشرف", "版主", "moderatore", "moderator", "moderátor");
            else role = T("membre", "member", "miembro", "участник", "Mitglied", "عضو", "成员", "membro", "membru", "tag");
            AccountLabel = Current.Pseudo.ToUpperInvariant() + "   -   " + role.ToUpperInvariant();
        }
        UiHoverKey = -2;
    }

    internal static void LoadAccount()
    {
        if (!File.Exists(AccountFile)) return;
        string raw = SafeRead(AccountFile);
        string pseudo = JsonString(raw, "pseudo");
        if (pseudo == "") return;
        Current = new Account();
        Current.Pseudo = pseudo;
        Current.Role = JsonString(raw, "role");
        Current.Access = JsonString(raw, "access");
        Current.Refresh = JsonString(raw, "refresh");
        UpdateAccountLabel();
        WriteLog("compte memorise : " + Current.Pseudo);
    }

    internal static void SaveAccount()
    {
        try
        {
            if (Current == null)
            {
                if (File.Exists(AccountFile)) File.Delete(AccountFile);
                return;
            }
            File.WriteAllText(AccountFile,
                "{\"pseudo\":\"" + Escape(Current.Pseudo) + "\",\"role\":\"" + Escape(Current.Role) +
                "\",\"access\":\"" + Escape(Current.Access) + "\",\"refresh\":\"" + Escape(Current.Refresh) + "\"}",
                new UTF8Encoding(false));
        }
        catch { }
    }

    internal static void DisconnectAccount()
    {
        Current = null;
        UpdateAccountLabel();
        SaveAccount();
        Status = T("Deconnecte - le jeu reste jouable sans compte.", "Signed out - you can still play without an account.", "Sesión cerrada: puedes jugar sin cuenta.", "Выход выполнен — играть можно и без аккаунта.", "Abgemeldet – das Spiel bleibt ohne Konto spielbar.", "تم تسجيل الخروج - يمكنك اللعب دون حساب.", "已退出登录，无需账号也可游玩。", "Disconnesso: puoi giocare anche senza account.", "Deconectat - poți juca și fără cont.", "Kijelentkezve – fiók nélkül is játszhatsz.");
        WriteLog("compte : deconnexion");
    }

    private static string Escape(string value)
    {
        return (value == null ? "" : value).Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    internal static string JsonString(string json, string key)
    {
        if (string.IsNullOrEmpty(json)) return "";
        Match match = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"([^\"]*)\"");
        return match.Success ? JsonUnescape(match.Groups[1].Value) : "";
    }

    // Les valeurs JSON sont ecrites avec des antislashs doubles (Escape). Sans ce
    // retour, un chemin Windows etait re-echappe a chaque sauvegarde et doublait
    // de taille jusqu'a rendre la config illisible.
    internal static string JsonUnescape(string value)
    {
        if (string.IsNullOrEmpty(value) || value.IndexOf('\\') < 0) return value;
        StringBuilder text = new StringBuilder(value.Length);
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if (c != '\\' || i + 1 >= value.Length)
            {
                text.Append(c);
                continue;
            }
            char next = value[++i];
            switch (next)
            {
                case '\\': text.Append('\\'); break;
                case '"': text.Append('"'); break;
                case '/': text.Append('/'); break;
                case 'b': text.Append('\b'); break;
                case 'f': text.Append('\f'); break;
                case 'n': text.Append('\n'); break;
                case 'r': text.Append('\r'); break;
                case 't': text.Append('\t'); break;
                default: text.Append('\\'); text.Append(next); break;
            }
        }
        return text.ToString();
    }

    internal static string AuthError(Exception failure)
    {
        // Le detail part au journal : sans lui, « injoignable » ne dit pas si c est le reseau,
        // le pare-feu ou la couche securisee qui a refuse.
        string detail = failure.GetType().Name + " : " + failure.Message;
        if (failure.InnerException != null) detail += " / " + failure.InnerException.Message;
        WriteLog("connexion : " + detail);

        WebException web = failure as WebException;
        if (web == null) return T("Connexion impossible : ", "Connection failed: ", "Conexión imposible: ", "Не удалось подключиться: ", "Verbindung fehlgeschlagen: ", "تعذر الاتصال: ", "无法连接：", "Connessione impossibile: ", "Conexiune imposibilă: ", "Nem sikerült kapcsolódni: ") + failure.Message;
        HttpWebResponse response = web.Response as HttpWebResponse;
        if (response == null)
        {
            if (failure.Message.IndexOf("SSL", StringComparison.OrdinalIgnoreCase) >= 0 ||
                failure.Message.IndexOf("TLS", StringComparison.OrdinalIgnoreCase) >= 0 ||
                failure.Message.IndexOf("securisee", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return T("Connexion securisee refusee (TLS). Verifie un VPN ou un antivirus qui inspecte le HTTPS.", "Secure connection refused (TLS). Check for a VPN or antivirus inspecting HTTPS.", "Conexión segura rechazada (TLS). Revisa un VPN o antivirus que inspeccione HTTPS.", "Защищённое соединение отклонено (TLS). Проверьте VPN или антивирус с проверкой HTTPS.", "Sichere Verbindung abgelehnt (TLS). Prüfe VPN oder Antivirus mit HTTPS-Prüfung.", "رُفض الاتصال الآمن (TLS). تحقق من VPN أو مضاد فيروسات يفحص HTTPS.", "安全连接被拒绝（TLS）。请检查 VPN 或会检查 HTTPS 的杀毒软件。", "Connessione sicura rifiutata (TLS). Controlla VPN o antivirus che ispeziona HTTPS.", "Conexiune securizată refuzată (TLS). Verifică un VPN sau antivirus care inspectează HTTPS.", "A biztonságos kapcsolat elutasítva (TLS). Ellenőrizd a VPN-t vagy a HTTPS-t vizsgáló vírusirtót.");
            }
            return T("Service de comptes injoignable : verifie la connexion internet.", "Account service unreachable: check your internet connection.", "Servicio de cuentas inaccesible: comprueba tu conexión.", "Служба аккаунтов недоступна: проверьте интернет.", "Kontodienst nicht erreichbar: prüfe deine Internetverbindung.", "خدمة الحسابات غير متاحة: تحقق من اتصالك بالإنترنت.", "账号服务无法访问：请检查网络连接。", "Servizio account irraggiungibile: controlla la connessione.", "Serviciul de conturi inaccesibil: verifică conexiunea la internet.", "A fiókszolgáltatás nem érhető el: ellenőrizd az internetkapcsolatot.");
        }
        int code = (int)response.StatusCode;
        if (code == 400 || code == 401) return T("Pseudo ou mot de passe incorrect.", "Wrong nickname or password.", "Apodo o contraseña incorrectos.", "Неверный псевдоним или пароль.", "Name oder Passwort falsch.", "الاسم أو كلمة المرور غير صحيحة.", "昵称或密码不正确。", "Nome o password errati.", "Poreclă sau parolă greșită.", "Hibás becenév vagy jelszó.");
        if (code == 429) return T("Trop de tentatives : patiente une minute.", "Too many attempts: wait a minute.", "Demasiados intentos: espera un minuto.", "Слишком много попыток: подождите минуту.", "Zu viele Versuche: warte eine Minute.", "محاولات كثيرة: انتظر دقيقة.", "尝试次数过多，请稍等一分钟。", "Troppi tentativi: attendi un minuto.", "Prea multe încercări: așteaptă un minut.", "Túl sok próbálkozás: várj egy percet.");
        return T("Connexion refusee (code ", "Connection refused (code ", "Conexión rechazada (código ", "Соединение отклонено (код ", "Verbindung abgelehnt (Code ", "رُفض الاتصال (الرمز ", "连接被拒绝（代码 ", "Connessione rifiutata (codice ", "Conexiune refuzată (cod ", "Kapcsolat elutasítva (kód ") + code + ").";
    }

    private static string PostJson(string url, string body)
    {
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
        request.Method = "POST";
        request.ContentType = "application/json";
        request.Headers.Add("apikey", SbKey);
        request.Timeout = 15000;
        byte[] payload = Encoding.UTF8.GetBytes(body);
        request.ContentLength = payload.Length;
        using (Stream stream = request.GetRequestStream()) { stream.Write(payload, 0, payload.Length); }
        using (WebResponse response = request.GetResponse())
        using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
        {
            return reader.ReadToEnd();
        }
    }

    private static string GetJson(string url, string bearer)
    {
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
        request.Method = "GET";
        request.Headers.Add("apikey", SbKey);
        request.Headers.Add("Authorization", "Bearer " + bearer);
        request.Timeout = 10000;
        using (WebResponse response = request.GetResponse())
        using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
        {
            return reader.ReadToEnd();
        }
    }

    // Renvoie une erreur lisible, ou une chaine vide si la connexion a reussi.
    internal static string ConnectAccount(string identifier, string password)
    {
        string email = identifier.Trim().ToLowerInvariant();
        if (email.IndexOf('@') < 0) email = email + "@" + PseudoDomain;

        string tokenJson;
        try
        {
            tokenJson = PostJson(SbUrl + "/auth/v1/token?grant_type=password",
                "{\"email\":\"" + Escape(email) + "\",\"password\":\"" + Escape(password) + "\"}");
        }
        catch (Exception failure) { return AuthError(failure); }

        string access = JsonString(tokenJson, "access_token");
        string refresh = JsonString(tokenJson, "refresh_token");
        if (access == "") return T("Reponse du service de comptes illisible.", "Unreadable reply from the account service.", "Respuesta ilegible del servicio de cuentas.", "Непонятный ответ службы аккаунтов.", "Unlesbare Antwort des Kontodienstes.", "رد غير مفهوم من خدمة الحسابات.", "账号服务返回无法识别的内容。", "Risposta illeggibile dal servizio account.", "Răspuns ilizibil de la serviciul de conturi.", "Érthetetlen válasz a fiókszolgáltatástól.");

        string pseudo = email;
        if (email.EndsWith("@" + PseudoDomain, StringComparison.OrdinalIgnoreCase))
        {
            pseudo = email.Substring(0, email.Length - PseudoDomain.Length - 1);
        }
        else
        {
            string metadata = JsonString(tokenJson, "pseudo");
            if (metadata != "") pseudo = metadata;
        }

        string role = "";
        try
        {
            Match user = Regex.Match(tokenJson, "\"user\"\\s*:\\s*\\{");
            string id = "";
            if (user.Success)
            {
                Match identity = Regex.Match(tokenJson.Substring(user.Index), "\"id\"\\s*:\\s*\"([0-9a-fA-F-]{36})\"");
                if (identity.Success) id = identity.Groups[1].Value;
            }
            if (id != "")
            {
                string rows = GetJson(SbUrl + "/rest/v1/profile?select=role&id=eq." + id, access);
                string found = JsonString(rows, "role");
                if (found != "") role = found;
            }
        }
        catch { }

        Current = new Account();
        Current.Pseudo = pseudo;
        Current.Role = role;
        Current.Access = access;
        Current.Refresh = refresh;
        UpdateAccountLabel();
        SaveAccount();
        WriteLog("compte : connexion " + pseudo);
        return "";
    }

    // ---- dessin --------------------------------------------------------------
    internal static GraphicsPath RoundRect(float x, float y, float w, float h, float r)
    {
        GraphicsPath path = new GraphicsPath();
        float d = r * 2;
        path.AddArc(x, y, d, d, 180, 90);
        path.AddArc(x + w - d, y, d, d, 270, 90);
        path.AddArc(x + w - d, y + h - d, d, d, 0, 90);
        path.AddArc(x, y + h - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    // La marque en trait du motif : EXACTEMENT la geometrie du SVG du site (viewBox 100 x 100).
    // Un seul cadre de 58 x 58 a (20,20), rayon 9, et un trait de 4 pour tout - plus le
    // "TT" et le sourire. L ancienne version dessinait un second cadre interieur et des
    // traits plus epais : c est ce qui rendait les logos du launcher differents du site.
    internal static void DrawMark(Graphics g, float cx, float cy, float size, Color ink, float lineScale,
        Color smile, bool plateFill, Color plateColor)
    {
        float k = size / 100.0f;
        float ox = cx - 50 * k;
        float oy = cy - 50 * k;
        float stroke = 4 * k * lineScale;

        using (GraphicsPath frame = RoundRect(ox + 20 * k, oy + 20 * k, 58 * k, 58 * k, 9 * k))
        {
            if (plateFill)
            {
                using (SolidBrush brush = new SolidBrush(plateColor)) { g.FillPath(brush, frame); }
            }
            using (Pen pen = new Pen(ink, stroke))
            {
                pen.LineJoin = LineJoin.Round;
                g.DrawPath(pen, frame);
            }
        }

        using (Pen pen = new Pen(ink, stroke))
        {
            pen.StartCap = LineCap.Round;
            pen.EndCap = LineCap.Round;
            pen.LineJoin = LineJoin.Round;
            // M33 37h32  M41 37v13  M57 37v13
            g.DrawLine(pen, ox + 33 * k, oy + 37 * k, ox + 65 * k, oy + 37 * k);
            g.DrawLine(pen, ox + 41 * k, oy + 37 * k, ox + 41 * k, oy + 50 * k);
            g.DrawLine(pen, ox + 57 * k, oy + 37 * k, ox + 57 * k, oy + 50 * k);
        }

        // M34 58q15 17 30 0 : meme courbe quadratique que le SVG, ecrite en bezier.
        float p0x = ox + 34 * k, p0y = oy + 58 * k;
        float qx = ox + 49 * k, qy = oy + 75 * k;
        float p2x = ox + 64 * k, p2y = oy + 58 * k;

        using (GraphicsPath smilePath = new GraphicsPath())
        using (Pen pen = new Pen(smile, stroke))
        {
            pen.StartCap = LineCap.Round;
            pen.EndCap = LineCap.Round;
            smilePath.AddBezier(
                p0x, p0y,
                p0x + (2.0f / 3.0f) * (qx - p0x), p0y + (2.0f / 3.0f) * (qy - p0y),
                p2x + (2.0f / 3.0f) * (qx - p2x), p2y + (2.0f / 3.0f) * (qy - p2y),
                p2x, p2y);
            g.DrawPath(pen, smilePath);
        }
    }

    // L embleme du site : plaque bleu nuit, cadres blancs, visage et sourire cyan plein.
    internal static void DrawEmblem(Graphics g, float cx, float cy, float size)
    {
        float k = size / 100f;
        float ox = cx - 50 * k;
        float oy = cy - 50 * k;
        Color white = Color.White;
        Color smile = Color.FromArgb(255, 79, 255, 242);

        using (GraphicsPath plate = RoundRect(ox + 5 * k, oy + 5 * k, 90 * k, 90 * k, 20 * k))
        {
            using (SolidBrush fill = new SolidBrush(Color.FromArgb(255, 0, 25, 184))) { g.FillPath(fill, plate); }
            using (Pen stroke = new Pen(white, 7 * k)) { stroke.LineJoin = LineJoin.Round; g.DrawPath(stroke, plate); }
        }
        using (GraphicsPath frame = RoundRect(ox + 17 * k, oy + 17 * k, 66 * k, 66 * k, 12 * k))
        using (Pen stroke = new Pen(white, 5 * k))
        {
            stroke.LineJoin = LineJoin.Round;
            g.DrawPath(stroke, frame);
        }
        using (Pen pen = new Pen(white, 7 * k))
        {
            pen.StartCap = LineCap.Round;
            pen.EndCap = LineCap.Round;
            g.DrawLine(pen, ox + 31 * k, oy + 34 * k, ox + 69 * k, oy + 34 * k);
            g.DrawLine(pen, ox + 40 * k, oy + 35 * k, ox + 40 * k, oy + 52 * k);
            g.DrawLine(pen, ox + 60 * k, oy + 35 * k, ox + 60 * k, oy + 52 * k);
        }
        using (GraphicsPath mouth = new GraphicsPath())
        {
            mouth.AddBezier(ox + 27 * k, oy + 59 * k, ox + 42 * k, oy + 72 * k, ox + 58 * k, oy + 72 * k, ox + 73 * k, oy + 59 * k);
            mouth.AddBezier(ox + 73 * k, oy + 59 * k, ox + 70 * k, oy + 80 * k, ox + 62 * k, oy + 86 * k, ox + 50 * k, oy + 84 * k);
            mouth.AddBezier(ox + 50 * k, oy + 84 * k, ox + 38 * k, oy + 86 * k, ox + 30 * k, oy + 80 * k, ox + 27 * k, oy + 59 * k);
            mouth.CloseFigure();
            using (SolidBrush fill = new SolidBrush(smile)) { g.FillPath(fill, mouth); }
        }
    }

    // La marque "REC BLUE" du site : lettres bleu profond, contour blanc epais, relief cyan
    // puis bleu nuit sous les lettres.
    internal static GraphicsPath DrawWordmark(Graphics g, string text, float size, float cx, float baseline)
    {
        GraphicsPath path = new GraphicsPath();
        StringFormat fmt = StringFormat.GenericTypographic;
        path.AddString(text, LogoFamily, (int)FontStyle.Bold, size, new PointF(0, 0), fmt);
        RectangleF bounds = path.GetBounds();
        using (Matrix matrix = new Matrix())
        {
            matrix.Translate(cx - bounds.Width / 2 - bounds.X, baseline - bounds.Height - bounds.Y);
            path.Transform(matrix);
        }

        float drop = size * 0.045f;

        using (GraphicsPath shadow = (GraphicsPath)path.Clone())
        using (Matrix matrix = new Matrix())
        using (SolidBrush brush = new SolidBrush(Color.FromArgb(120, 3, 21, 78)))
        {
            matrix.Translate(0, drop * 2.6f);
            shadow.Transform(matrix);
            g.FillPath(brush, shadow);
        }
        using (GraphicsPath relief = (GraphicsPath)path.Clone())
        using (Matrix matrix = new Matrix())
        using (SolidBrush brush = new SolidBrush(Color.FromArgb(255, 8, 38, 127)))
        {
            matrix.Translate(0, drop * 1.7f);
            relief.Transform(matrix);
            g.FillPath(brush, relief);
        }
        using (GraphicsPath glow = (GraphicsPath)path.Clone())
        using (Matrix matrix = new Matrix())
        using (SolidBrush brush = new SolidBrush(Color.FromArgb(255, 119, 234, 255)))
        {
            matrix.Translate(0, drop);
            glow.Transform(matrix);
            g.FillPath(brush, glow);
        }

        using (Pen outline = new Pen(Color.White, (float)Math.Max(3.0, size * 0.055)))
        {
            outline.LineJoin = LineJoin.Round;
            g.DrawPath(outline, path);
        }
        using (SolidBrush fill = new SolidBrush(Color.FromArgb(255, 6, 50, 201)))
        {
            g.FillPath(fill, path);
        }
        return path;
    }

    // Fond fourni : l image 1600x900 est recadree en "cover" pour remplir le
    // launcher 960x600 sans la deformer.
    private static Bitmap LoadBackdrop(int w, int h)
    {
        try
        {
            using (Stream stream = System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream("RecBlueBackdrop.png"))
            {
                if (stream == null) return BuildBackground(w, h);
                using (Bitmap source = new Bitmap(stream))
                {
                    Bitmap result = new Bitmap(w, h);
                    using (Graphics g = Graphics.FromImage(result))
                    {
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                        float scale = Math.Max(w / (float)source.Width, h / (float)source.Height);
                        float dw = source.Width * scale;
                        float dh = source.Height * scale;
                        g.DrawImage(source, new RectangleF((w - dw) / 2f, (h - dh) / 2f, dw, dh));
                    }
                    return result;
                }
            }
        }
        catch { return BuildBackground(w, h); }
    }

    internal static Bitmap BuildBackground(int w, int h)
    {
        Bitmap bitmap = new Bitmap(w, h);
        using (Graphics g = Graphics.FromImage(bitmap))
        using (LinearGradientBrush brush = new LinearGradientBrush(new Rectangle(0, 0, w, h),
            Color.FromArgb(33, 116, 250), Color.FromArgb(12, 52, 188), 60f))
        {
            g.FillRectangle(brush, 0, 0, w, h);
        }
        return bitmap;
    }

    // Les deux halos du site. Leur respiration (opacite) est pre-calculee en quelques etapes :
    // redimensionner une grande image et lui appliquer une matrice a chaque image coutait
    // 8 ms a elle seule.
    internal static Bitmap[] BuildLightFrames(int w, int h)
    {
        Bitmap[] frames = new Bitmap[6];
        for (int i = 0; i < frames.Length; i++)
        {
            frames[i] = BuildLight(w, h, 0.65 + 0.35 * (i / 5.0));
        }
        return frames;
    }

    private static Bitmap BuildLight(int w, int h, double factor)
    {
        Bitmap bitmap = new Bitmap(w, h);
        using (Graphics g = Graphics.FromImage(bitmap))
        {
            g.Clear(Color.Transparent);
            g.SmoothingMode = SmoothingMode.AntiAlias;

            DrawHalo(g, w * 0.28f, h * 0.35f, w * 0.49f, h * 0.49f,
                Color.FromArgb((int)Math.Round(69 * factor), 69, 186, 255));
            DrawHalo(g, w * 0.75f, h * 0.65f, w * 0.55f, h * 0.55f,
                Color.FromArgb((int)Math.Round(85 * factor), 57, 91, 255));
        }
        return bitmap;
    }

    private static void DrawHalo(Graphics g, float cx, float cy, float rx, float ry, Color center)
    {
        using (GraphicsPath path = new GraphicsPath())
        {
            path.AddEllipse(cx - rx, cy - ry, rx * 2, ry * 2);
            using (PathGradientBrush brush = new PathGradientBrush(path))
            {
                brush.CenterColor = center;
                brush.SurroundColors = new Color[] { Color.FromArgb(0, center.R, center.G, center.B) };
                g.FillPath(brush, path);
            }
        }
    }

    // Le motif : des marques cyan a 20 % sur une grille de 165 px, inclinees comme le site.
    internal static Bitmap BuildPattern(int w, int h, int margin = 1)
    {
        int pw = w + Cell * margin;
        int ph = h + Cell * margin;
        const int ss = 2;   // rendu deux fois plus grand puis reduit : traits nets

        using (Bitmap big = new Bitmap(pw * ss, ph * ss))
        {
            using (Graphics g = Graphics.FromImage(big))
            {
                g.Clear(Color.Transparent);
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;

                Color ink = Color.FromArgb(51, 91, 234, 255);
                float step = Cell * ss;
                float reach = (float)Math.Sqrt((pw * ss) * (pw * ss) + (ph * ss) * (ph * ss)) / 2.0f + step;

                // Comme sur le site, c est la GRILLE entiere qui est inclinee de -24 degres,
                // pas chaque marque : les rangs doivent etre inclines, pas seulement les logos.
                g.TranslateTransform(pw * ss / 2.0f, ph * ss / 2.0f);
                g.RotateTransform(-24);
                for (float y = -reach; y <= reach; y += step)
                {
                    for (float x = -reach; x <= reach; x += step)
                    {
                        DrawMark(g, x, y, step, ink, 1.0f, ink, false, Color.Empty);
                    }
                }
            }

            Bitmap bitmap = new Bitmap(pw, ph);
            using (Graphics g = Graphics.FromImage(bitmap))
            {
                g.Clear(Color.Transparent);
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(big, new Rectangle(0, 0, pw, ph));
            }
            return bitmap;
        }
    }

    // Quatre variantes pre-decalees d une demi-image : le motif se deplace
    // en sous-pixel sans reechantillonnage plein ecran a chaque frame.
    private static void BuildPatternPhases()
    {
        if (PatBmp == null) return;
        PatPhaseBmp = new Bitmap[4];
        for (int iy = 0; iy < 2; iy++)
        {
            for (int ix = 0; ix < 2; ix++)
            {
                Bitmap phase = new Bitmap(W, H);
                using (Graphics g = Graphics.FromImage(phase))
                {
                    g.InterpolationMode = InterpolationMode.HighQualityBilinear;
                    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g.DrawImage(PatBmp, ix * 0.5f, iy * 0.5f);
                }
                PatPhaseBmp[iy * 2 + ix] = phase;
            }
        }
    }

    // Meme principe que le motif : huit decalages verticaux du logo, pour un
    // flottement au huitieme de pixel au lieu d un saut d un pixel.
    private static void BuildLogoPhases()
    {
        if (LogoBmp == null) return;
        LogoPhaseBmp = new Bitmap[LogoPhases];
        for (int i = 0; i < LogoPhases; i++)
        {
            Bitmap phase = new Bitmap(W, H);
            using (Graphics g = Graphics.FromImage(phase))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBilinear;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(LogoBmp, 0, i / (float)LogoPhases);
            }
            LogoPhaseBmp[i] = phase;
        }
    }

    private static void DrawPattern(Graphics g, double time)
    {
        if (PatBmp == null) return;
        if (PatPhaseBmp == null || PatPhaseBmp.Length < 4)
        {
            g.InterpolationMode = InterpolationMode.NearestNeighbor;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.DrawImageUnscaled(PatBmp, 0, -Cell);
            return;
        }

        // Meme drift incline que le site, quantifie au demi-pixel le plus proche.
        double phase = (time * PatternSpeed) % Cell;
        double rad = -24.0 * Math.PI / 180.0;
        double x = -1.5 * Cell - phase * (Math.Cos(rad) + Math.Sin(rad));
        double y = -2.0 * Cell + phase * (Math.Cos(rad) - Math.Sin(rad));
        int baseX = (int)Math.Floor(x);
        int baseY = (int)Math.Floor(y);
        double fx = x - baseX;
        double fy = y - baseY;
        int ix = 0;
        int iy = 0;
        if (fx >= 0.75) { baseX++; }
        else if (fx >= 0.25) { ix = 1; }
        if (fy >= 0.75) { baseY++; }
        else if (fy >= 0.25) { iy = 1; }

        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.DrawImageUnscaled(PatPhaseBmp[iy * 2 + ix], baseX, baseY);
    }

    internal static Bitmap BuildLogo(int w, int h)
    {
        Bitmap bitmap = new Bitmap(w, h);
        using (Graphics g = Graphics.FromImage(bitmap))
        {
            g.Clear(Color.Transparent);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;

            StringFormat fmt = StringFormat.GenericTypographic;

            if (IntroTitle != null)
            {
                // Meme logo neige que l'ecran de chargement : l'ecran titre reste
                // coherent d'un bout a l'autre du launcher. Une ombre douce le detache
                // du motif bleu.
                float targetWidth = 300f;
                float ratio = IntroTitle.Height / (float)IntroTitle.Width;
                float targetHeight = targetWidth * ratio;
                float left = (w - targetWidth) / 2f;
                float top = 12f;
                Rectangle dest = new Rectangle((int)Math.Round(left), (int)Math.Round(top),
                    (int)Math.Round(targetWidth), (int)Math.Round(targetHeight));

                InterpolationMode previous = g.InterpolationMode;
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                DrawSilhouette(g, IntroTitle, dest, Color.FromArgb(255, 3, 16, 56), 4, 6, 0.35f);
                g.DrawImage(IntroTitle, dest);
                g.PixelOffsetMode = PixelOffsetMode.Default;
                g.InterpolationMode = previous;
            }
            else if (LogoImage != null)
            {
                // Secours : logo horizontal du site si la ressource neige manque.
                float targetWidth = 600f;
                float ratio = LogoImage.Height / (float)LogoImage.Width;
                float targetHeight = targetWidth * ratio;
                float left = (w - targetWidth) / 2f;
                float top = LogoCenterY - targetHeight / 2f;

                InterpolationMode previous = g.InterpolationMode;
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.DrawImage(LogoImage, new RectangleF(left, top, targetWidth, targetHeight));
                g.InterpolationMode = previous;
            }
            else
            {
                float line1Size = 112f;
                float line2Size = 128f;

                RectangleF probeBounds;
                using (GraphicsPath probe = new GraphicsPath())
                {
                    probe.AddString("REC", LogoFamily, (int)FontStyle.Bold, line1Size, new PointF(0, 0), fmt);
                    probeBounds = probe.GetBounds();
                }

                float emblemSize = 132f;
                float gap = 16f;

                // Comme sur le site, la marque est legerement inclinee.
                using (Matrix tilt = new Matrix())
                {
                    tilt.RotateAt(-2f, new PointF(w / 2f, 240f));
                    g.Transform = tilt;

                    float line1Width = probeBounds.Width + gap + emblemSize;
                    float left = (w - line1Width) / 2;

                    using (GraphicsPath one = DrawWordmark(g, "REC", line1Size, left + probeBounds.Width / 2, LogoBaseline1)) { }
                    DrawEmblem(g, left + probeBounds.Width + gap + emblemSize / 2, LogoBaseline1 - probeBounds.Height / 2, emblemSize);
                    using (GraphicsPath two = DrawWordmark(g, "BLUE", line2Size, w / 2f, LogoBaseline2)) { }
                }
            }

            using (GraphicsPath sub = new GraphicsPath())
            {
                sub.AddString(
                    T("Bienvenue sur REC BLUE", "Welcome to REC BLUE", "Bienvenido a REC BLUE", "Добро пожаловать в REC BLUE", "Willkommen bei REC BLUE", "مرحباً بك في REC BLUE", "欢迎来到 REC BLUE", "Benvenuto su REC BLUE", "Bine ai venit pe REC BLUE", "Üdv a REC BLUE oldalán"),
                    (Lang == "ru" || Lang == "ar" || Lang == "zh") ? new FontFamily(UiFamily) : LogoFamily,
                    (int)FontStyle.Bold, 24f, new PointF(0, 0), fmt);
                RectangleF bounds = sub.GetBounds();
                float x = (w - bounds.Width) / 2 - bounds.X;
                float y = SubBaseline - bounds.Y;

                using (GraphicsPath shadow = (GraphicsPath)sub.Clone())
                using (Matrix matrix = new Matrix())
                using (SolidBrush brush = new SolidBrush(Color.FromArgb(90, 8, 24, 70)))
                {
                    matrix.Translate(x + 2, y + 3);
                    shadow.Transform(matrix);
                    g.FillPath(brush, shadow);
                }
                using (Matrix matrix = new Matrix())
                {
                    matrix.Translate(x, y);
                    sub.Transform(matrix);
                }
                using (Pen outline = new Pen(Color.FromArgb(80, 6, 20, 60), 3)) { g.DrawPath(outline, sub); }
                using (SolidBrush fill = new SolidBrush(Cream)) { g.FillPath(fill, sub); }
            }
        }
        return bitmap;
    }

    internal static Bitmap BuildUi(int w, int h, int hover, string status, string account)
    {
        Bitmap bitmap = new Bitmap(w, h);
        using (Graphics g = Graphics.FromImage(bitmap))
        {
            g.Clear(Color.Transparent);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;

            // Statut en pilule sombre, avec le point vert du serveur.
            DrawStatusPill(g, w, status);

            int bw = 198, bh = 86, gapB = 12;
            int totalB = bw * 4 + gapB * 3;
            int bx1 = (w - totalB) / 2;
            int[] xs = new int[] { bx1, bx1 + bw + gapB, bx1 + 2 * (bw + gapB), bx1 + 3 * (bw + gapB) };
            string[] labels = new string[] {
                T("JOUER", "PLAY", "JUGAR", "ИГРАТЬ", "SPIELEN", "العب", "开始游戏", "GIOCA", "JOACĂ", "JÁTÉK"),
                T("JOUER EN VR", "PLAY IN VR", "JUGAR EN VR", "ИГРАТЬ В VR", "IN VR SPIELEN", "العب بالواقع الافتراضي", "VR 模式开始", "GIOCA IN VR", "JOACĂ ÎN VR", "JÁTÉK VR-BEN"),
                T("REPARER", "REPAIR", "REPARAR", "ИСПРАВИТЬ", "REPARIEREN", "إصلاح", "修复", "RIPARA", "REPARĂ", "JAVÍTÁS"),
                T("INSTALLER", "INSTALL", "INSTALAR", "УСТАНОВИТЬ", "INSTALLIEREN", "تثبيت", "安装", "INSTALLA", "INSTALEAZĂ", "TELEPÍTÉS")
            };
            for (int i = 0; i < 4; i++)
            {
                DrawActionButton(g, i, xs[i], ButtonY, bw, bh, labels[i], hover == i + 1);
            }

            // Une seule ligne pour le compte, le stockage et la desinstallation.
            int[] pills = PillRow();
            DrawPill(g, pills[0], PillY, 240, PillHeight, hover == 5,
                Color.FromArgb(36, 65, 122), Color.FromArgb(22, 41, 79), account,
                UiFont(11f, FontStyle.Bold), Cream, 5);

            if (Current != null)
            {
                DrawPill(g, pills[1], PillY, 160, PillHeight, hover == 6,
                    Color.FromArgb(96, 42, 54), Color.FromArgb(58, 30, 40),
                    T("SE DECONNECTER", "LOG OUT", "CERRAR SESIÓN", "ВЫЙТИ", "ABMELDEN", "تسجيل الخروج", "退出登录", "ESCI", "DECONECTARE", "KIJELENTKEZÉS"),
                    UiFont(9.5f, FontStyle.Bold), Cream, 8);
            }

            // Dossier de stockage du jeu, puis desinstallation de l installation REC BLUE.
            DrawPill(g, pills[2], PillY, 160, PillHeight, hover == 7,
                Color.FromArgb(36, 65, 122), Color.FromArgb(22, 41, 79),
                T("STOCKAGE", "STORAGE", "ALMACENAMIENTO", "ХРАНИЛИЩЕ", "SPEICHER", "التخزين", "存储", "ARCHIVIO", "STOCARE", "TÁROLÁS"),
                UiFont(10f, FontStyle.Bold), Cream, 6);
            DrawPill(g, pills[3], PillY, 170, PillHeight, hover == 8,
                Color.FromArgb(80, 38, 48), Color.FromArgb(22, 41, 79),
                T("DESINSTALLER", "UNINSTALL", "DESINSTALAR", "УДАЛИТЬ", "DEINSTALLIEREN", "إلغاء التثبيت", "卸载", "DISINSTALLA", "DEZINSTALEAZĂ", "ELTÁVOLÍTÁS"),
                UiFont(10f, FontStyle.Bold), Cream, 7);

            // Selecteur de cadence, selecteur de langue et croix de fermeture.
            DrawFpsPill(g, FpsRect(w), hover == 11);
            DrawLanguagePill(g, LangRect(w), hover == 10);
            DrawCloseButton(g, CloseRect(w), hover == 9);

            using (Font footFont = new Font("Segoe UI", 10.5f))
            using (SolidBrush footBrush = new SolidBrush(Color.FromArgb(175, 255, 248, 231)))
            {
                g.DrawString("recblue.net  •  serveur privé", footFont, footBrush, 26, h - 32);
            }

            // Confirmation visible que les deux plugins sont charges apres le demarrage
            // du jeu : l etat vient du journal BepInEx, pas d une simple presence de fichier.
            if (PluginState != "")
            {
                string pluginLine = T("Plugins : ", "Plugins: ", "Plugins: ", "Плагины: ", "Plugins: ", "الإضافات: ", "插件：", "Plugin: ", "Pluginuri: ", "Bővítmények: ") + PluginState;
                bool failed = PluginState.IndexOf("KO", StringComparison.Ordinal) >= 0;
                bool loaded = PluginState.IndexOf("OK", StringComparison.Ordinal) >= 0;
                using (Font pluginFont = new Font("Segoe UI", 10.5f))
                using (SolidBrush pluginBrush = new SolidBrush(failed
                    ? Color.FromArgb(255, 255, 198, 124)
                    : (loaded ? Color.FromArgb(235, 168, 240, 180) : Color.FromArgb(155, 255, 248, 231))))
                {
                    SizeF pluginSize = g.MeasureString(pluginLine, pluginFont);
                    g.DrawString(pluginLine, pluginFont, pluginBrush, w - 26 - pluginSize.Width, h - 32);
                }
            }
        }
        return bitmap;
    }

    private static void DrawPill(Graphics g, float x, float y, float w, float h, bool hover,
        Color hoverColor, Color baseColor, string label, Font font, Color textColor, int icon)
    {
        using (GraphicsPath shadow = RoundRect(x, y + 3, w, h, h / 2))
        using (SolidBrush shadowBrush = new SolidBrush(Color.FromArgb(55, 3, 12, 40)))
        {
            g.FillPath(shadowBrush, shadow);
        }
        using (GraphicsPath path = RoundRect(x, y, w, h, h / 2))
        {
            using (SolidBrush brush = new SolidBrush(hover ? hoverColor : baseColor)) { g.FillPath(brush, path); }
            using (Pen edge = new Pen(Color.FromArgb(245, 255, 248, 231), 2.6f)) { g.DrawPath(edge, path); }
        }

        if (icon > 0) DrawIcon(g, icon, new RectangleF(x + 16, y + (h - 24) / 2f, 24, 24), textColor);

        float left = icon > 0 ? x + 42 : x + 10;
        float available = w - (left - x) - 12;
        float size = font.Size;
        Font use = font;
        SizeF measured = g.MeasureString(label, use);
        while (measured.Width > available && size > 8f)
        {
            size -= 0.5f;
            if (use != font) use.Dispose();
            use = new Font(font.FontFamily, size, font.Style);
            measured = g.MeasureString(label, use);
        }
        using (SolidBrush brush = new SolidBrush(textColor))
        {
            g.DrawString(label, use, brush, left + (available - measured.Width) / 2,
                y + (h - measured.Height) / 2);
        }
        if (use != font) use.Dispose();
        font.Dispose();
    }

    // Lit le journal BepInEx pour savoir si RecNet et RecBlueFps ont reellement ete
    // charges dans la derniere session du jeu. Limite a une lecture toutes les 1,5 s.
    private static void RefreshPluginState()
    {
        if ((DateTime.UtcNow - PluginCheckedAt).TotalSeconds < 1.5) return;
        PluginCheckedAt = DateTime.UtcNow;
        string state;
        try
        {
            string plugins = Path.Combine(GameDir, "BepInEx", "plugins");
            bool netInstalled = File.Exists(Path.Combine(plugins, "RecNetPlugin.dll"));
            bool fpsInstalled = File.Exists(Path.Combine(plugins, "RecBlueFps.dll"));
            if (!netInstalled && !fpsInstalled)
            {
                state = T("non installés", "not installed", "no instalados", "не установлены", "nicht installiert", "غير مثبتة", "未安装", "non installati", "neinstalate", "nincs telepítve");
            }
            else
            {
                bool netLoaded = false, fpsLoaded = false;
                string log = Path.Combine(GameDir, "BepInEx", "LogOutput.log");
                if (File.Exists(log))
                {
                    // BepInEx garde le journal ouvert en ecriture pendant la partie : sans
                    // FileShare.ReadWrite la lecture echoue et l etat resterait "en attente".
                    string text = "";
                    try
                    {
                        using (FileStream stream = new FileStream(log, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                        using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                        {
                            text = reader.ReadToEnd();
                        }
                    }
                    catch { }
                    netLoaded = text.IndexOf("Loading [RecNet Plugin", StringComparison.OrdinalIgnoreCase) >= 0;
                    fpsLoaded = text.IndexOf("Loading [REC BLUE - FPS", StringComparison.OrdinalIgnoreCase) >= 0;
                }
                if (netLoaded && fpsLoaded) state = "RecNet OK   •   FPS OK";
                else if (!netLoaded && !fpsLoaded)
                    state = T("en attente du chargement du jeu", "waiting for the game to load", "esperando a que cargue el juego", "ожидание загрузки игры", "wartet auf das Laden des Spiels", "في انتظار تحميل اللعبة", "等待游戏加载", "in attesa del caricamento del gioco", "se așteaptă încărcarea jocului", "várakozás a játék betöltésére");
                else state = (netLoaded ? "RecNet OK" : "RecNet KO") + "   •   " + (fpsLoaded ? "FPS OK" : "FPS KO");
            }
        }
        catch { state = ""; }
        PluginState = state;
    }

    // ---- diagnostic Steam -----------------------------------------------------
    // Le client est un build Steam : il appelle Steamworks avant tout appel reseau. Sans
    // Steam connecte, il s'arrete sur une erreur que le joueur ne peut pas interpreter.
    // Ces trois tests permettent de nommer la cause au lieu de la subir.
    private static string SteamPlayerLog()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            @"AppData\LocalLow\Against Gravity\Rec Room\Player.log");
    }

    private static bool SteamRunning()
    {
        try { return Process.GetProcessesByName("steam").Length > 0; }
        catch { return false; }
    }

    // Chemin de steam.exe, lu dans le registre : Steam n'est pas toujours dans Program Files.
    private static string SteamExePath()
    {
        try
        {
            using (Microsoft.Win32.RegistryKey key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam"))
            {
                object value = key == null ? null : key.GetValue("SteamExe");
                string path = value as string;
                if (!string.IsNullOrEmpty(path) && File.Exists(path)) return path.Replace('/', '\\');
            }
        }
        catch { }
        string fallback = @"C:\Program Files (x86)\Steam\steam.exe";
        return File.Exists(fallback) ? fallback : "";
    }

    // Steam note le choix hors ligne dans loginusers.vdf. Mesure du 11/11/2026 : hors
    // ligne, Steamworks s'initialise mais le client echoue faute de ticket de session.
    private static bool SteamOffline()
    {
        try
        {
            string exe = SteamExePath();
            if (exe == "") return false;
            string vdf = Path.Combine(Path.GetDirectoryName(exe), @"config\loginusers.vdf");
            if (!File.Exists(vdf)) return false;
            foreach (Match match in Regex.Matches(SafeRead(vdf), "\"WantsOfflineMode\"\\s*\"(\\d+)\""))
            {
                if (match.Groups[1].Value == "1") return true;
            }
        }
        catch { }
        return false;
    }

    // Message unique pour les deux cas ou Steam n'accorde pas de licence : avant le
    // lancement (sonde) et apres coup (journal du client). Meme cause, meme phrase.
    private static string SteamLicenseMessage()
    {
        return T("Steam ne reconnait pas ce compte pour Rec Room (471710) : connecte-toi dans Steam et verifie que le jeu est dans ta bibliotheque. Rec Room n'etant plus vendu, un compte qui ne l'a jamais eu ne peut plus l'obtenir.", "Steam does not recognise this account for Rec Room (471710): sign in to Steam and check that the game is in your library. Rec Room is no longer sold, so an account that never had it cannot get it anymore.", "Steam no reconoce esta cuenta para Rec Room (471710): inicia sesion en Steam y comprueba que el juego esta en tu biblioteca. Rec Room ya no se vende, asi que una cuenta que nunca lo tuvo no puede obtenerlo.", "Steam не распознаёт этот аккаунт для Rec Room (471710): войдите в Steam и проверьте, что игра есть в библиотеке. Rec Room больше не продаётся, поэтому аккаунт, у которого её никогда не было, получить её не сможет.", "Steam erkennt dieses Konto nicht für Rec Room (471710): melde dich in Steam an und prüfe, ob das Spiel in deiner Bibliothek ist. Rec Room wird nicht mehr verkauft, ein Konto ohne das Spiel kann es also nicht mehr bekommen.", "لا يتعرّف Steam على هذا الحساب بالنسبة إلى Rec Room (471710): سجّل الدخول في Steam وتأكد من وجود اللعبة في مكتبتك. لم تعد Rec Room تُباع، لذا لا يمكن لحساب لم يحصل عليها سابقاً أن يحصل عليها الآن.", "Steam 无法识别此账号的 Rec Room（471710）：请登录 Steam 并确认游戏在库中。Rec Room 已停售，从未拥有过它的账号无法再获取。", "Steam non riconosce questo account per Rec Room (471710): accedi a Steam e controlla che il gioco sia nella tua libreria. Rec Room non è più in vendita, quindi un account che non l'ha mai avuto non può più ottenerlo.", "Steam nu recunoaște acest cont pentru Rec Room (471710): autentifică-te în Steam și verifică dacă jocul este în bibliotecă. Rec Room nu mai este vândut, așa că un cont care nu l-a avut niciodată nu îl mai poate obține.", "A Steam nem ismeri fel ezt a fiókot a Rec Roomhoz (471710): jelentkezz be a Steamba, és ellenőrizd, hogy a játék a könyvtáradban van. A Rec Roomot már nem árulják, így egy fiók, amelyben még soha nem volt meg, már nem szerezheti meg.");
    }

    // Lance la sonde de licence dans %TEMP% : le dossier du jeu n'est jamais touche (on
    // copie steam_api64.dll et on ecrit son propre steam_appid.txt). Retourne true
    // seulement si Steam refuse de s'initialiser, donc si l'echec est etabli : une sonde
    // qui n'a pas pu tourner renvoie false et ne bloque jamais le lancement.
    private static bool SteamLicenseMissing()
    {
        string dll = Path.Combine(GameDir, @"RecRoom_Data\Plugins\x86_64\steam_api64.dll");
        if (!File.Exists(dll)) return false;
        string dir = Path.Combine(Path.GetTempPath(), "REC-BLUE-steamcheck");
        IntPtr library = IntPtr.Zero;
        string previousAppId = null;
        string previousGameId = null;
        try
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
            Directory.CreateDirectory(dir);
            File.Copy(dll, Path.Combine(dir, "steam_api64.dll"), true);
            string appId = Environment.GetEnvironmentVariable("RECBLUE_STEAM_APPID");
            if (string.IsNullOrEmpty(appId)) appId = "471710";
            // steam_api lit l'AppID dans le repertoire courant (steam_appid.txt), donc dans un
            // dossier temporaire il ne trouve rien et echoue meme pour un compte proprietaire :
            // mesure du 12/11/2026, ce faux refus a bloque un compte qui possede le jeu. Les
            // variables SteamAppId/SteamGameId donnent le bon verdict quel que soit le dossier :
            // 471710 -> succes, 1091500 et 292030 (non possedes) -> echec.
            previousAppId = Environment.GetEnvironmentVariable("SteamAppId");
            previousGameId = Environment.GetEnvironmentVariable("SteamGameId");
            Environment.SetEnvironmentVariable("SteamAppId", appId);
            Environment.SetEnvironmentVariable("SteamGameId", appId);

            library = LoadLibrary(Path.Combine(dir, "steam_api64.dll"));
            if (library == IntPtr.Zero)
            {
                WriteLog("sonde licence Steam : DLL non chargeable, verification ignoree");
                return false;
            }
            IntPtr init = GetProcAddress(library, "SteamAPI_Init");
            if (init == IntPtr.Zero)
            {
                WriteLog("sonde licence Steam : SteamAPI_Init absent, verification ignoree");
                return false;
            }
            SteamInitCall start = (SteamInitCall)System.Runtime.InteropServices.Marshal.GetDelegateForFunctionPointer(init, typeof(SteamInitCall));
            bool ok = start();
            WriteLog("sonde licence Steam (app " + appId + ") : " + (ok ? "licence reconnue" : "licence refusee"));
            if (ok)
            {
                IntPtr shutdown = GetProcAddress(library, "SteamAPI_Shutdown");
                if (shutdown != IntPtr.Zero)
                {
                    SteamShutdownCall stop = (SteamShutdownCall)System.Runtime.InteropServices.Marshal.GetDelegateForFunctionPointer(shutdown, typeof(SteamShutdownCall));
                    try { stop(); } catch { }
                }
            }
            return !ok;
        }
        catch (Exception error)
        {
            WriteLog("sonde licence Steam impossible : " + error.Message);
            return false;
        }
        finally
        {
            if (library != IntPtr.Zero) { try { FreeLibrary(library); } catch { } }
            Environment.SetEnvironmentVariable("SteamAppId", previousAppId);
            Environment.SetEnvironmentVariable("SteamGameId", previousGameId);
            try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch { }
        }
    }

    // Lit la fin du journal du client pendant le chargement et traduit un refus Steam.
    // Le journal est reecrit a chaque lancement : on ignore un fichier plus ancien que
    // le demarrage en cours, sinon une session precedente ferait un faux diagnostic.
    private static string SteamRefusal()
    {
        if ((DateTime.UtcNow - SteamCheckedAt).TotalSeconds < 1.5) return SteamDiagnosis;
        SteamCheckedAt = DateTime.UtcNow;
        SteamDiagnosis = "";
        string log = SteamPlayerLog();
        string text;
        try
        {
            FileInfo info = new FileInfo(log);
            if (!info.Exists || info.LastWriteTime < LaunchAt) return "";
            using (FileStream stream = new FileStream(log, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                long size = stream.Length;
                if (size > 32768) stream.Seek(size - 32768, SeekOrigin.Begin);
                using (StreamReader reader = new StreamReader(stream, Encoding.UTF8)) text = reader.ReadToEnd();
            }
        }
        catch { return ""; }

        if (text.IndexOf("Failed to initialize Steam Platform", StringComparison.Ordinal) < 0) return "";
        if (!SteamRunning())
        {
            SteamDiagnosis = T("Steam n'a pas demarre : ouvre Steam, connecte-toi, puis relance le jeu.", "Steam did not start: open Steam, sign in, then launch the game again.", "Steam no arrancó: abre Steam, inicia sesión y vuelve a lanzar el juego.", "Steam не запустился: откройте Steam, войдите в аккаунт и запустите игру снова.", "Steam wurde nicht gestartet: öffne Steam, melde dich an und starte das Spiel erneut.", "لم يبدأ Steam: افتح Steam وسجّل الدخول ثم أعد تشغيل اللعبة.", "Steam 未启动：请打开 Steam 并登录，然后重新启动游戏。", "Steam non avviato: apri Steam, accedi e rilancia il gioco.", "Steam nu a pornit: deschide Steam, autentifică-te și relansează jocul.", "A Steam nem indult el: nyisd meg a Steamet, jelentkezz be, majd indítsd újra a játékot.");
        }
        else if (SteamOffline())
        {
            SteamDiagnosis = T("Steam est en mode hors ligne : remets-le en ligne, sinon le jeu s'arrete a la connexion.", "Steam is in offline mode: go back online, otherwise the game stops at sign-in.", "Steam está en modo sin conexión: vuelve a conectarlo o el juego se detiene al iniciar sesión.", "Steam в автономном режиме: верните его в сеть, иначе игра остановится на входе.", "Steam ist im Offline-Modus: geh wieder online, sonst bricht das Spiel bei der Anmeldung ab.", "Steam في وضع عدم الاتصال: أعد الاتصال وإلا تتوقف اللعبة عند الدخول.", "Steam 处于离线模式：请恢复在线，否则游戏会在登录时停止。", "Steam è in modalità offline: torna online, altrimenti il gioco si ferma all'accesso.", "Steam este în modul offline: revino online, altfel jocul se oprește la autentificare.", "A Steam offline módban van: kapcsold vissza online, különben a játék a bejelentkezésnél leáll.");
        }
        else
        {
            SteamDiagnosis = SteamLicenseMessage();
        }
        return SteamDiagnosis;
    }

    private static void DrawStatusPill(Graphics g, int w, string status)
    {
        if (status == null) status = "";
        status = status.Replace("  -  ", "  •  ").Replace(" - ", " • ");
        float size = 12.5f;
        Font font = UiFont(size, FontStyle.Bold);
        SizeF measured = g.MeasureString(status, font);
        while (measured.Width > 700f && size > 9.5f)
        {
            font.Dispose();
            size -= 0.5f;
            font = UiFont(size, FontStyle.Bold);
            measured = g.MeasureString(status, font);
        }
        float pillW = Math.Min(780f, Math.Max(240f, measured.Width + 70f));
        float pillH = 34f;
        float pillX = (w - pillW) / 2f;
        using (GraphicsPath shadow = RoundRect(pillX, StatusY + 3, pillW, pillH, pillH / 2f))
        using (SolidBrush shadowBrush = new SolidBrush(Color.FromArgb(50, 3, 12, 40)))
        {
            g.FillPath(shadowBrush, shadow);
        }
        using (GraphicsPath path = RoundRect(pillX, StatusY, pillW, pillH, pillH / 2f))
        {
            using (SolidBrush brush = new SolidBrush(Color.FromArgb(235, 16, 30, 64))) g.FillPath(brush, path);
            using (Pen edge = new Pen(Color.FromArgb(245, 255, 248, 231), 2.5f)) g.DrawPath(edge, path);
        }
        using (SolidBrush dot = new SolidBrush(ServerOk ? Color.FromArgb(255, 56, 214, 107) : Color.FromArgb(255, 138, 152, 176)))
        {
            g.FillEllipse(dot, pillX + 20, StatusY + pillH / 2f - 6f, 12, 12);
        }
        using (SolidBrush textBrush = new SolidBrush(Color.FromArgb(255, 255, 250, 240)))
        using (StringFormat left = new StringFormat())
        {
            left.Alignment = StringAlignment.Near;
            left.LineAlignment = StringAlignment.Center;
            left.FormatFlags = StringFormatFlags.NoWrap;
            g.DrawString(status, font, textBrush, new RectangleF(pillX + 42, StatusY, pillW - 52, pillH), left);
        }
        font.Dispose();
    }

    private static void DrawActionButton(Graphics g, int index, float x, float y, float w, float h,
        string label, bool hover)
    {
        Color top, bottom, baseColor;
        switch (index)
        {
            case 1:
                top = Color.FromArgb(255, 72, 180, 245); bottom = Color.FromArgb(255, 30, 127, 214); baseColor = Color.FromArgb(255, 11, 78, 142);
                break;
            case 2:
                top = Color.FromArgb(255, 192, 123, 238); bottom = Color.FromArgb(255, 139, 63, 209); baseColor = Color.FromArgb(255, 83, 32, 143);
                break;
            case 3:
                top = Color.FromArgb(255, 155, 210, 74); bottom = Color.FromArgb(255, 95, 165, 36); baseColor = Color.FromArgb(255, 55, 109, 18);
                break;
            default:
                top = Color.FromArgb(255, 255, 164, 61); bottom = Color.FromArgb(255, 249, 115, 22); baseColor = Color.FromArgb(255, 184, 72, 11);
                break;
        }

        // Au survol : le bouton se souleve, grossit de 2 %, s eclaircit et
        // s entoure d un halo creme. Les hitbox restent celles de la maquette.
        float scale = hover ? 1.02f : 1f;
        float lift = hover ? 4f : 0f;
        float bw = w * scale;
        float bh = h * scale;
        float bx = x + (w - bw) / 2f;
        float by = y - lift + (h - bh) / 2f;

        if (hover)
        {
            using (GraphicsPath glow = RoundRect(bx - 4f, by - 4f, bw + 8f, bh + 8f, 23f))
            using (Pen glowPen = new Pen(Color.FromArgb(90, 255, 248, 231), 7f))
            {
                g.DrawPath(glowPen, glow);
            }
        }

        using (GraphicsPath shadow = RoundRect(bx, by + (hover ? 9f : 6f), bw, bh, 20))
        using (SolidBrush shadowBrush = new SolidBrush(baseColor))
        {
            g.FillPath(shadowBrush, shadow);
        }
        using (GraphicsPath face = RoundRect(bx, by, bw, bh, 20))
        {
            Color faceTop = hover ? Lighten(top, 22) : top;
            Color faceBottom = hover ? Lighten(bottom, 12) : bottom;
            using (LinearGradientBrush brush = new LinearGradientBrush(
                new RectangleF(bx, by, bw, bh), faceTop, faceBottom, LinearGradientMode.Vertical))
            {
                g.FillPath(brush, face);
            }
            if (hover)
            {
                using (SolidBrush light = new SolidBrush(Color.FromArgb(48, 255, 255, 255))) g.FillPath(light, face);
            }
            using (Pen edge = new Pen(hover ? Color.FromArgb(255, 255, 255, 250) : Cream, hover ? 4.2f : 3.5f)) g.DrawPath(edge, face);
        }

        DrawIcon(g, index + 1, new RectangleF(bx + 16, by + (bh - 38) / 2f, 38, 38), Color.White);

        float size = 21f;
        Font font = new Font(DisplayFamily, size, FontStyle.Bold);
        float available = bw - 74;
        SizeF measured = g.MeasureString(label, font);
        while (measured.Width > available && size > 12f)
        {
            font.Dispose();
            size -= 0.5f;
            font = new Font(DisplayFamily, size, FontStyle.Bold);
            measured = g.MeasureString(label, font);
        }
        float tx = bx + 58 + (available - measured.Width) / 2f;
        float ty = by + (bh - measured.Height) / 2f;
        using (SolidBrush shadowText = new SolidBrush(Color.FromArgb(90, 32, 22, 12)))
        {
            g.DrawString(label, font, shadowText, tx + 1.5f, ty + 2f);
        }
        using (SolidBrush brush = new SolidBrush(Color.FromArgb(255, 255, 252, 244)))
        {
            g.DrawString(label, font, brush, tx, ty);
        }
        font.Dispose();
    }

    private static Color Lighten(Color color, int amount)
    {
        return Color.FromArgb(color.A,
            Math.Min(255, color.R + amount),
            Math.Min(255, color.G + amount),
            Math.Min(255, color.B + amount));
    }

    private static void DrawLanguagePill(Graphics g, Rectangle r, bool hover)
    {
        using (GraphicsPath path = RoundRect(r.X, r.Y, r.Width, r.Height, r.Height / 2f))
        {
            using (SolidBrush brush = new SolidBrush(hover ? Color.FromArgb(48, 82, 148) : Color.FromArgb(22, 41, 79))) g.FillPath(brush, path);
            using (Pen edge = new Pen(Color.FromArgb(245, 255, 248, 231), 2.6f)) g.DrawPath(edge, path);
        }
        using (Font font = new Font("Segoe UI", 11f, FontStyle.Bold))
        using (SolidBrush brush = new SolidBrush(Cream))
        {
            string code = LangCodes[LangIndex].ToUpperInvariant();
            SizeF measured = g.MeasureString(code, font);
            g.DrawString(code, font, brush, r.X + (r.Width - measured.Width) / 2f - 9f, r.Y + (r.Height - measured.Height) / 2f);
            using (Pen chevron = new Pen(Cream, 2.4f))
            {
                chevron.StartCap = LineCap.Round;
                chevron.EndCap = LineCap.Round;
                float cx = r.Right - 22f;
                float cy = r.Y + r.Height / 2f - 2f;
                g.DrawLine(chevron, cx - 4f, cy, cx, cy + 4f);
                g.DrawLine(chevron, cx, cy + 4f, cx + 4f, cy);
            }
        }
    }

    private static void DrawFpsPill(Graphics g, Rectangle r, bool hover)
    {
        using (GraphicsPath path = RoundRect(r.X, r.Y, r.Width, r.Height, r.Height / 2f))
        {
            using (SolidBrush brush = new SolidBrush(hover ? Color.FromArgb(48, 82, 148) : Color.FromArgb(22, 41, 79))) g.FillPath(brush, path);
            using (Pen edge = new Pen(Color.FromArgb(245, 255, 248, 231), 2.6f)) g.DrawPath(edge, path);
        }
        string label = FpsManual ? "FPS " + FpsLimit : "AUTO " + FpsLimit;
        using (Font font = new Font("Segoe UI", 10.5f, FontStyle.Bold))
        using (SolidBrush brush = new SolidBrush(Cream))
        using (StringFormat centered = new StringFormat())
        {
            centered.Alignment = StringAlignment.Center;
            centered.LineAlignment = StringAlignment.Center;
            g.DrawString(label, font, brush, new RectangleF(r.X, r.Y, r.Width, r.Height), centered);
        }
    }

    private static void DrawCloseButton(Graphics g, Rectangle r, bool hover)
    {
        using (GraphicsPath path = RoundRect(r.X, r.Y, r.Width, r.Height, 10f))
        {
            using (SolidBrush brush = new SolidBrush(hover ? Color.FromArgb(255, 240, 92, 74) : Color.FromArgb(255, 226, 59, 59))) g.FillPath(brush, path);
            using (Pen edge = new Pen(Color.FromArgb(245, 255, 248, 231), 3f)) g.DrawPath(edge, path);
        }
        using (Pen pen = new Pen(Color.FromArgb(255, 255, 250, 242), 3.6f))
        {
            pen.StartCap = LineCap.Round;
            pen.EndCap = LineCap.Round;
            float inset = 12f;
            g.DrawLine(pen, r.Left + inset, r.Top + inset, r.Right - inset, r.Bottom - inset);
            g.DrawLine(pen, r.Right - inset, r.Top + inset, r.Left + inset, r.Bottom - inset);
        }
    }

    private static void DrawSilhouette(Graphics g, Image image, Rectangle dest, Color color, int dx, int dy, float alpha)
    {
        using (ImageAttributes attrs = new ImageAttributes())
        {
            ColorMatrix matrix = new ColorMatrix(new float[][]
            {
                new float[] { 0f, 0f, 0f, 0f, 0f },
                new float[] { 0f, 0f, 0f, 0f, 0f },
                new float[] { 0f, 0f, 0f, 0f, 0f },
                new float[] { 0f, 0f, 0f, alpha, 0f },
                new float[] { color.R / 255f, color.G / 255f, color.B / 255f, 0f, 1f }
            });
            attrs.SetColorMatrix(matrix, ColorMatrixFlag.Default, ColorAdjustType.Bitmap);
            g.DrawImage(image, new Rectangle(dest.X + dx, dest.Y + dy, dest.Width, dest.Height),
                0, 0, image.Width, image.Height, GraphicsUnit.Pixel, attrs);
        }
    }

    private static void DrawIcon(Graphics g, int icon, RectangleF box, Color color)
    {
        float cx = box.Left + box.Width / 2f;
        float cy = box.Top + box.Height / 2f;
        switch (icon)
        {
            case 1: // lecture
                {
                    using (GraphicsPath path = new GraphicsPath())
                    {
                        path.AddPolygon(new PointF[]
                        {
                            new PointF(box.Left + box.Width * 0.22f, box.Top + box.Height * 0.14f),
                            new PointF(box.Left + box.Width * 0.22f, box.Bottom - box.Height * 0.14f),
                            new PointF(box.Right - box.Width * 0.12f, cy)
                        });
                        path.CloseFigure();
                        using (SolidBrush brush = new SolidBrush(color)) g.FillPath(brush, path);
                        using (Pen pen = new Pen(color, 5f)) { pen.LineJoin = LineJoin.Round; g.DrawPath(pen, path); }
                    }
                }
                break;
            case 2: // casque VR
                {
                    float x = box.Left + box.Width * 0.06f;
                    float y = box.Top + box.Height * 0.24f;
                    float w = box.Width * 0.88f;
                    float h = box.Height * 0.52f;
                    using (GraphicsPath path = new GraphicsPath(FillMode.Alternate))
                    {
                        path.AddPath(RoundRect(x, y, w, h, h * 0.42f), false);
                        path.AddPath(RoundRect(x + w * 0.15f, y + h * 0.28f, w * 0.30f, h * 0.40f, 3f), false);
                        path.AddPath(RoundRect(x + w * 0.55f, y + h * 0.28f, w * 0.30f, h * 0.40f, 3f), false);
                        using (SolidBrush brush = new SolidBrush(color)) g.FillPath(brush, path);
                    }
                }
                break;
            case 3: // cle plate, ouverte vers le haut
                {
                    GraphicsState state = g.Save();
                    g.TranslateTransform(cx, cy);
                    g.RotateTransform(-42f);
                    using (Pen pen = new Pen(color, 5f))
                    {
                        pen.StartCap = LineCap.Round;
                        pen.EndCap = LineCap.Round;
                        g.DrawLine(pen, 0f, -2f, 0f, 16f);
                        g.DrawLine(pen, -8f, -14f, -8f, -4f);
                        g.DrawArc(pen, -8f, -9f, 16f, 11f, 180f, 180f);
                        g.DrawLine(pen, 8f, -4f, 8f, -14f);
                    }
                    g.Restore(state);
                }
                break;
            case 4: // telechargement
                {
                    using (Pen pen = new Pen(color, 4.6f))
                    {
                        pen.StartCap = LineCap.Round;
                        pen.EndCap = LineCap.Round;
                        pen.LineJoin = LineJoin.Round;
                        g.DrawLine(pen, cx, box.Top + 4f, cx, box.Top + box.Height * 0.58f);
                        g.DrawLine(pen, cx - 7f, box.Top + box.Height * 0.38f, cx, box.Top + box.Height * 0.60f);
                        g.DrawLine(pen, cx + 7f, box.Top + box.Height * 0.38f, cx, box.Top + box.Height * 0.60f);
                        g.DrawLine(pen, box.Left + 7f, box.Top + box.Height * 0.74f, box.Left + 7f, box.Bottom - 5f);
                        g.DrawLine(pen, box.Left + 7f, box.Bottom - 5f, box.Right - 7f, box.Bottom - 5f);
                        g.DrawLine(pen, box.Right - 7f, box.Bottom - 5f, box.Right - 7f, box.Top + box.Height * 0.74f);
                    }
                }
                break;
            case 5: // personne
                {
                    float head = box.Width * 0.30f;
                    using (SolidBrush brush = new SolidBrush(color))
                    {
                        g.FillEllipse(brush, cx - head / 2f, box.Top + 3f, head, head);
                        using (GraphicsPath body = new GraphicsPath())
                        {
                            body.AddArc(box.Left + box.Width * 0.16f, box.Top + box.Height * 0.46f,
                                box.Width * 0.68f, box.Height * 0.56f, 180f, 180f);
                            body.AddLine(box.Right - box.Width * 0.16f, box.Bottom,
                                box.Left + box.Width * 0.16f, box.Bottom);
                            body.CloseFigure();
                            g.FillPath(brush, body);
                        }
                    }
                }
                break;
            case 6: // dossier
                {
                    using (GraphicsPath path = new GraphicsPath(FillMode.Winding))
                    {
                        path.AddPath(RoundRect(box.Left + 3f, box.Top + box.Height * 0.28f,
                            box.Width - 6f, box.Height * 0.58f, 4f), false);
                        path.AddPath(RoundRect(box.Left + 6f, box.Top + box.Height * 0.16f,
                            box.Width * 0.46f, box.Height * 0.24f, 3f), false);
                        using (SolidBrush brush = new SolidBrush(color)) g.FillPath(brush, path);
                    }
                }
                break;
            case 7: // corbeille
                {
                    using (Pen pen = new Pen(color, 4f))
                    {
                        pen.StartCap = LineCap.Round;
                        pen.EndCap = LineCap.Round;
                        g.DrawLine(pen, box.Left + 7f, box.Top + box.Height * 0.30f, box.Right - 7f, box.Top + box.Height * 0.30f);
                        g.DrawLine(pen, cx - 5f, box.Top + box.Height * 0.18f, cx + 5f, box.Top + box.Height * 0.18f);
                        g.DrawLine(pen, box.Left + 10f, box.Top + box.Height * 0.34f, box.Left + 12f, box.Bottom - 5f);
                        g.DrawLine(pen, box.Right - 10f, box.Top + box.Height * 0.34f, box.Right - 12f, box.Bottom - 5f);
                        g.DrawLine(pen, box.Left + 12f, box.Bottom - 5f, box.Right - 12f, box.Bottom - 5f);
                        g.DrawLine(pen, cx - 4f, box.Top + box.Height * 0.42f, cx - 5f, box.Bottom - box.Height * 0.18f);
                        g.DrawLine(pen, cx + 4f, box.Top + box.Height * 0.42f, cx + 5f, box.Bottom - box.Height * 0.18f);
                    }
                }
                break;
            case 8: // deconnexion
                {
                    using (Pen pen = new Pen(color, 4.2f))
                    {
                        pen.StartCap = LineCap.Round;
                        pen.EndCap = LineCap.Round;
                        g.DrawLine(pen, box.Left + 6f, box.Top + 8f, box.Left + 6f, box.Bottom - 8f);
                        g.DrawLine(pen, box.Left + 6f, box.Top + 8f, box.Left + box.Width * 0.46f, box.Top + 8f);
                        g.DrawLine(pen, box.Left + 6f, box.Bottom - 8f, box.Left + box.Width * 0.46f, box.Bottom - 8f);
                        g.DrawLine(pen, box.Left + box.Width * 0.42f, cy, box.Right - 5f, cy);
                        g.DrawLine(pen, box.Right - 13f, cy - 7f, box.Right - 5f, cy);
                        g.DrawLine(pen, box.Right - 13f, cy + 7f, box.Right - 5f, cy);
                    }
                }
                break;
        }
    }

    // Positions de la ligne du bas : compte, deconnexion, stockage, desinstallation.
    // Tout est calcule ici pour que le dessin et les zones de clic ne puissent pas diverger.
    private const int PillHeight = 42;
    private const int PillGap = 14;

    internal static int[] PillRow()
    {
        bool connected = Current != null;
        int total = 240 + PillGap + 160 + PillGap + 170 + (connected ? PillGap + 160 : 0);
        int x = (W - total) / 2;
        int[] xs = new int[4];
        xs[0] = x;
        x += 240 + PillGap;
        xs[1] = connected ? x : -1;
        if (connected) x += 160 + PillGap;
        xs[2] = x;
        x += 160 + PillGap;
        xs[3] = x;
        return xs;
    }

    private static bool OnPill(int x0, int width, int x, int y)
    {
        return x >= x0 && x <= x0 + width && y >= PillY && y <= PillY + PillHeight;
    }

    private static void RenderIntro(Graphics g, int w, int h)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;

        // Meme decor que le reste du launcher, mais en bleu : la page "Chambres"
        // du site sert de reference pour les deux animations. Le motif de logos
        // avance d'une cellule (165 px) en 6 s dans son repere incline de -24 deg,
        // et les deux halos respirent sur 14 s en aller-retour.
        double introTime = Math.Max(0.0, Anim - IntroStartAnim);
        if (BgBmp != null) g.DrawImageUnscaled(BgBmp, 0, 0);
        DrawPattern(g, introTime);
        DrawLightDrift(g, w, h, introTime);

        if (IntroTitleCache == null) BuildIntroTitleCache(w);
        if (IntroTitleCache != null)
        {
            // Entree en fondu echelonnee sur 0,85 s (courbe ease-out cubique),
            // puis flottement continu de 3 px a taille fixe.
            double enter = Math.Min(1.0, introTime / 0.85);
            float ease = (float)(1.0 - Math.Pow(1.0 - enter, 3.0));
            float titleW = w * 0.44f;
            float titleH = titleW * IntroTitleCache.Height / IntroTitleCache.Width;
            float scale = (float)(0.90 + 0.10 * ease);
            float destW = titleW * scale;
            float destH = titleH * scale;
            float titleY = h * 0.07f + (1f - ease) * 14f + (float)Math.Sin(introTime * 0.8) * 3f;
            if (ease < 1f)
            {
                RectangleF dest = new RectangleF((w - destW) / 2f, titleY, destW, destH);
                using (ImageAttributes attrs = new ImageAttributes())
                {
                    ColorMatrix matrix = new ColorMatrix();
                    matrix.Matrix33 = ease;
                    attrs.SetColorMatrix(matrix, ColorMatrixFlag.Default, ColorAdjustType.Bitmap);
                    g.DrawImage(IntroTitleCache, Rectangle.Round(dest), 0f, 0f, IntroTitleCache.Width, IntroTitleCache.Height,
                        GraphicsUnit.Pixel, attrs);
                }
            }
            else
            {
                float titleX = (w - IntroTitleCache.Width) / 2f;
                float titleYFloat = h * 0.07f + (float)Math.Sin(introTime * 0.8) * 3f;
                g.DrawImage(IntroTitleCache, new RectangleF(titleX, titleYFloat, IntroTitleCache.Width, IntroTitleCache.Height),
                    new RectangleF(0, 0, IntroTitleCache.Width, IntroTitleCache.Height), GraphicsUnit.Pixel);
            }
        }
        g.PixelOffsetMode = PixelOffsetMode.Default;

        int barW = Math.Min(460, w - 100);
        int barH = 14;
        int barX = (w - barW) / 2;
        int barY = (int)(h * 0.76f);
        using (GraphicsPath track = RoundRect(barX, barY, barW, barH, barH / 2f))
        {
            using (SolidBrush fill = new SolidBrush(Color.FromArgb(45, 255, 255, 255))) g.FillPath(fill, track);
            using (Pen edge = new Pen(Color.FromArgb(235, 255, 255, 255), 2.4f)) g.DrawPath(edge, track);
        }

        double progress = Math.Max(0.0, Math.Min(1.0, IntroProgress));
        int fillW = (int)Math.Round((barW - 4) * progress);
        if (fillW > 0)
        {
            using (GraphicsPath fill = RoundRect(barX + 2, barY + 2, fillW, barH - 4, (barH - 4) / 2f))
            using (SolidBrush brush = new SolidBrush(Color.FromArgb(255, 102, 247, 244)))
            {
                g.FillPath(brush, fill);

                // Un reflet traverse le remplissage en boucle (180 px/s) : la barre
                // reste vivante meme quand la progression ralentit en fin de chargement.
                GraphicsState saved = g.Save();
                g.SetClip(fill);
                float sheenW = 90f;
                float span = fillW + sheenW * 2f;
                float sheenX = barX + 2 - sheenW + (float)((introTime * 180.0) % span);
                using (LinearGradientBrush sheen = new LinearGradientBrush(
                    new RectangleF(sheenX, barY, sheenW, barH),
                    Color.FromArgb(0, 255, 255, 255), Color.FromArgb(0, 255, 255, 255), LinearGradientMode.Horizontal))
                {
                    ColorBlend blend = new ColorBlend(3);
                    blend.Colors = new Color[]
                    {
                        Color.FromArgb(0, 255, 255, 255),
                        Color.FromArgb(110, 255, 255, 255),
                        Color.FromArgb(0, 255, 255, 255)
                    };
                    blend.Positions = new float[] { 0f, 0.5f, 1f };
                    sheen.InterpolationColors = blend;
                    g.FillRectangle(sheen, sheenX, barY + 2, sheenW, barH - 4);
                }
                g.Restore(saved);
            }
        }

        string label = progress >= 0.95
            ? T("Terminé", "Done", "Terminado", "Готово", "Fertig", "تم", "完成", "Fine", "Terminat", "Kész")
            : T("Chargement...", "Loading...", "Cargando...", "Загрузка...", "Wird geladen...", "جارٍ التحميل...", "正在加载...", "Caricamento...", "Se încarcă...", "Betöltés...");
        using (Font font = UiFont(13f, FontStyle.Bold))
        using (StringFormat center = new StringFormat())
        using (SolidBrush shadow = new SolidBrush(Color.FromArgb(110, 3, 14, 45)))
        using (SolidBrush brush = new SolidBrush(Color.FromArgb(245, 255, 255, 255)))
        {
            center.Alignment = StringAlignment.Center;
            RectangleF rect = new RectangleF(0, barY + 30, w, 30);
            g.DrawString(label, font, shadow, new RectangleF(1, rect.Y + 2, rect.Width, rect.Height), center);
            g.DrawString(label, font, brush, rect, center);
        }

        DrawCloseButton(g, CloseRect(w), false);
    }

    internal static void RenderFrame(Graphics g, int w, int h, double ox, double oy, double anim, bool loading,
        double spin, string status, int hover)
    {
        if (Intro && IntroFadeBmp == null)
        {
            RenderIntro(g, w, h);
            return;
        }

        // Le menu reprend le temps de l intro : motif et halos restent en phase
        // pendant le fondu enchaine, puis continuent leur drift.
        double mainTime = Math.Max(0.0, anim - IntroStartAnim);

        g.InterpolationMode = InterpolationMode.NearestNeighbor;
        g.DrawImageUnscaled(BgBmp, 0, 0);

        // Motif pre-rendu en quatre phases : une seule copie 1:1 par frame.
        DrawPattern(g, mainTime);
        g.PixelOffsetMode = PixelOffsetMode.Default;

        DrawLightDrift(g, w, h, mainTime);

        g.InterpolationMode = InterpolationMode.NearestNeighbor;
        // Flottement continu du logo : amplitude portee a 7 px pour que le
        // mouvement reste nettement visible sur le menu. Les huit phases
        // pre-rendues evitent le saut d un pixel de l arrondi entier.
        float reveal = (float)Math.Max(0.0, Math.Min(1.0, MenuReveal));
        if (reveal > 0f)
        {
            float logoBob = (float)(Math.Sin(mainTime * 0.8) * 7.0);
            Bitmap logoPhase = LogoBmp;
            int logoY = (int)Math.Round(logoBob);
            if (LogoPhaseBmp != null && LogoPhaseBmp.Length == LogoPhases)
            {
                int baseY = (int)Math.Floor(logoBob);
                int phase = (int)Math.Round((logoBob - baseY) * LogoPhases);
                if (phase >= LogoPhases) { baseY++; phase = 0; }
                logoPhase = LogoPhaseBmp[phase];
                logoY = baseY;
            }
            if (reveal >= 0.999f) g.DrawImageUnscaled(logoPhase, 0, logoY);
            else
            {
                using (ImageAttributes attrs = new ImageAttributes())
                {
                    ColorMatrix matrix = new ColorMatrix();
                    matrix.Matrix33 = reveal;
                    attrs.SetColorMatrix(matrix, ColorMatrixFlag.Default, ColorAdjustType.Bitmap);
                    g.DrawImage(logoPhase, new Rectangle(0, logoY, logoPhase.Width, logoPhase.Height),
                        0, 0, logoPhase.Width, logoPhase.Height, GraphicsUnit.Pixel, attrs);
                }
            }
        }

        if (loading)
        {
            float scx = w / 2f;
            float scy = 470f;
            float rad = 27f;
            using (Pen track = new Pen(Color.FromArgb(55, 255, 255, 255), 6)) { g.DrawEllipse(track, scx - rad, scy - rad, rad * 2, rad * 2); }
            using (Pen arc = new Pen(Color.FromArgb(255, 254, 113, 1), 6))
            {
                arc.StartCap = LineCap.Round;
                arc.EndCap = LineCap.Round;
                g.DrawArc(arc, scx - rad, scy - rad, rad * 2, rad * 2, (float)spin, 100);
            }
            using (SolidBrush dot = new SolidBrush(Color.FromArgb(255, 102, 247, 244)))
            {
                g.FillEllipse(dot, scx - 4, scy - 4, 8, 8);
            }
            using (Font font = UiFont(11.5f, FontStyle.Regular))
            using (SolidBrush brush = new SolidBrush(Color.FromArgb(235, 255, 255, 255)))
            using (StringFormat center = new StringFormat())
            {
                center.Alignment = StringAlignment.Center;
                g.DrawString(LoadText, font, brush, new RectangleF(0, scy + 38, w, 28), center);
            }
        }
        else if (reveal > 0f)
        {
            RefreshPluginState();
            if (UiHoverKey != hover || UiStatus != status || UiAccount != AccountLabel || UiPlugins != PluginState || UiBmp == null)
            {
                if (UiBmp != null) UiBmp.Dispose();
                UiBmp = BuildUi(w, h, hover, status, AccountLabel);
                UiHoverKey = hover;
                UiStatus = status;
                UiAccount = AccountLabel;
                UiPlugins = PluginState;
            }
            if (reveal >= 0.999f) g.DrawImageUnscaled(UiBmp, 0, 0);
            else
            {
                using (ImageAttributes attrs = new ImageAttributes())
                {
                    ColorMatrix matrix = new ColorMatrix();
                    matrix.Matrix33 = reveal;
                    attrs.SetColorMatrix(matrix, ColorMatrixFlag.Default, ColorAdjustType.Bitmap);
                    g.DrawImage(UiBmp, new Rectangle(0, 0, w, h), 0, 0, w, h, GraphicsUnit.Pixel, attrs);
                }
            }

            // Le liseré suit les coins arrondis de la fenetre et ferme proprement le cadre.
            SmoothingMode previousMode = g.SmoothingMode;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath edge = RoundRect(1f, 1f, w - 2f, h - 2f, WindowRadius - 1f))
            using (Pen edgePen = new Pen(Color.FromArgb((int)Math.Round(70 * reveal), 255, 255, 255), 2f))
            {
                g.DrawPath(edgePen, edge);
            }
            g.SmoothingMode = previousMode;
        }

        // Fondu enchaine : l intro fige s efface et revele le menu deja dessine.
        if (Intro && IntroFadeBmp != null)
        {
            float alpha = 1f - (float)Math.Max(0.0, Math.Min(1.0, IntroFade));
            if (alpha > 0f)
            {
                using (ImageAttributes attributes = new ImageAttributes())
                {
                    ColorMatrix matrix = new ColorMatrix();
                    matrix.Matrix33 = alpha;
                    attributes.SetColorMatrix(matrix, ColorMatrixFlag.Default, ColorAdjustType.Bitmap);
                    g.DrawImage(IntroFadeBmp, new Rectangle(0, 0, w, h), 0, 0, w, h, GraphicsUnit.Pixel, attributes);
                }
            }
        }
    }

    // hero-light-drift : 14 s, aller-retour, de (-3 %, -2 %) a (3 %, 2 %) et de 1 a 1,08.
    private static void DrawLightDrift(Graphics g, int w, int h, double anim)
    {
        if (LightFrames == null) return;
        double cycle = LightCycle * 2.0;
        double phase = (anim % cycle) / LightCycle;
        if (phase > 1.0) phase = 2.0 - phase;
        float p = (float)phase;
        float eased = p * p * (3f - 2f * p);

        float scale = 1f + 0.08f * eased;
        float dx = (-0.03f + 0.06f * eased) * w;
        float dy = (-0.02f + 0.04f * eased) * h;

        // La position et l agrandissement passent par la transformation (en flottants) : la
        // destination reste donc en sous-pixel, sans a-coup d arrondi.
        int index = (int)Math.Round(eased * (LightFrames.Length - 1));
        Bitmap frame = LightFrames[index];
        float halfW = frame.Width / 2f;
        float halfH = frame.Height / 2f;

        // Le halo est stocke a mi-resolution (un degrade tres doux ne perd rien) : le tirer
        // deux fois coute bien moins que de dessiner une pleine image floue a chaque image.
        Matrix previous = g.Transform;
        InterpolationMode previousMode = g.InterpolationMode;
        g.InterpolationMode = InterpolationMode.NearestNeighbor;
        g.TranslateTransform(w / 2f + dx, h / 2f + dy);
        g.ScaleTransform(2f * scale, 2f * scale);
        g.TranslateTransform(-halfW, -halfH);
        g.DrawImage(frame, 0, 0);
        g.Transform = previous;
        g.InterpolationMode = previousMode;
    }

    // ---- fenetre -------------------------------------------------------------
    private sealed class Canvas : Panel
    {
        public Canvas()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                     ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
        }
    }

    internal static void KeepWindowOnScreen(Form form)
    {
        if (form == null) return;
        Rectangle area = Screen.FromControl(form).WorkingArea;
        int left = Math.Max(area.Left, Math.Min(form.Left, area.Right - form.Width));
        int top = Math.Max(area.Top, Math.Min(form.Top, area.Bottom - form.Height));
        if (form.Left != left) form.Left = left;
        if (form.Top != top) form.Top = top;
    }

    internal static bool IsSupportedFps(int fps) { return fps == 60 || fps == 120 || fps == 240; }

    private static int ChooseFpsForHz(int hz)
    {
        if (hz >= 200) return 240;
        if (hz >= 110) return 120;
        return 60;
    }

    private static int DetectScreenHz(Form form)
    {
        int hz = 0;
        IntPtr dc = IntPtr.Zero;
        bool screenDc = false;
        try
        {
            Screen screen = form != null ? Screen.FromControl(form) : Screen.PrimaryScreen;
            dc = CreateDC("DISPLAY", screen.DeviceName, null, IntPtr.Zero);
            if (dc == IntPtr.Zero)
            {
                dc = GetDC(IntPtr.Zero);
                screenDc = true;
            }
            if (dc != IntPtr.Zero) hz = GetDeviceCaps(dc, VREFRESH);
        }
        catch { }
        finally
        {
            if (dc != IntPtr.Zero)
            {
                if (screenDc) ReleaseDC(IntPtr.Zero, dc);
                else DeleteDC(dc);
            }
        }
        if (hz < 20) hz = 60;
        return hz;
    }

    // Mesure le cout de peinture du menu avant de choisir AUTO : une frequence
    // d ecran elevee ne sert a rien si le rendu ne peut pas suivre.
    private static double MeasureFrameCost()
    {
        if (BgBmp == null || PatBmp == null || LogoBmp == null) return 0.0;
        bool wasIntro = Intro;
        double wasReveal = MenuReveal;
        Intro = false;
        MenuReveal = 1.0;
        try
        {
            using (Bitmap probe = new Bitmap(W, H))
            using (Graphics g = Graphics.FromImage(probe))
            {
                for (int i = 0; i < 3; i++) RenderFrame(g, W, H, 0, 0, 0, false, 0, Status, 0);
                Stopwatch timer = Stopwatch.StartNew();
                const int frames = 5;
                for (int i = 0; i < frames; i++) RenderFrame(g, W, H, 0, 0, i * 0.016, false, 0, Status, 0);
                timer.Stop();
                return timer.Elapsed.TotalMilliseconds / frames;
            }
        }
        catch { return 0.0; }
        finally { Intro = wasIntro; MenuReveal = wasReveal; }
    }

    // AUTO part de la frequence de l ecran, puis redescend a 120 ou 60 si la
    // peinture du menu ne laisse pas assez de temps entre deux images.
    private static void ApplyAutoFps(Form form)
    {
        int hz = DetectScreenHz(form);
        int target = ChooseFpsForHz(hz);
        double frameMs = MeasureFrameCost();
        int sustainable = 60;
        if (frameMs > 0.0 && frameMs <= 1000.0 / 120.0 * 0.80) sustainable = 120;
        if (frameMs > 0.0 && frameMs <= 1000.0 / 240.0 * 0.80) sustainable = 240;
        if (target > sustainable) target = sustainable;
        FpsLimit = target;
        WriteLog("cadence : auto -> " + FpsLimit + " i/s (ecran " + hz + " Hz, rendu " +
                 frameMs.ToString("0.0", CultureInfo.InvariantCulture) + " ms)");
    }

    private static void CycleFps(Form form)
    {
        if (!FpsManual)
        {
            FpsLimit = 60;
            FpsManual = true;
        }
        else if (FpsLimit == 60) FpsLimit = 120;
        else if (FpsLimit == 120) FpsLimit = 240;
        else
        {
            FpsManual = false;
            ApplyAutoFps(form);
        }
        if (UiBmp != null)
        {
            UiBmp.Dispose();
            UiBmp = null;
        }
        UiHoverKey = -2;
        SaveConfig();
        if (FpsManual) WriteLog("cadence : " + FpsLimit + " i/s");
    }

    internal static int ButtonX(int index)
    {
        int total = 198 * 4 + 12 * 3;
        return (W - total) / 2 + index * (198 + 12);
    }

    internal static bool InButton(int index, int x, int y)
    {
        int bx = ButtonX(index);
        return x >= bx && x <= bx + 198 && y >= ButtonY && y <= ButtonY + 86;
    }

    internal static bool InAccount(int x, int y) { return OnPill(PillRow()[0], 240, x, y); }
    internal static bool InLogout(int x, int y)
    {
        int left = PillRow()[1];
        return left >= 0 && OnPill(left, 160, x, y);
    }
    internal static bool InStorage(int x, int y) { return OnPill(PillRow()[2], 160, x, y); }
    internal static bool InUninstall(int x, int y) { return OnPill(PillRow()[3], 170, x, y); }

    internal static Rectangle CloseRect(int w) { return new Rectangle(w - 64, 16, 40, 40); }
    internal static Rectangle LangRect(int w) { return new Rectangle(w - 164, 16, 88, 36); }
    internal static Rectangle FpsRect(int w) { return new Rectangle(w - 264, 16, 88, 36); }
    internal static bool InLang(int x, int y) { return LangRect(W).Contains(x, y); }
    internal static bool InClose(int x, int y) { return CloseRect(W).Contains(x, y); }
    internal static bool InFps(int x, int y) { return FpsRect(W).Contains(x, y); }

    // La fenetre est etiree a la zone de travail : les coordonnees souris sont
    // ramenees vers le repere de conception 960x600 utilise par les controles.
    private static Point ToDesign(Control surface, int x, int y)
    {
        if (surface == null || surface.Width <= 0 || surface.Height <= 0) return new Point(x, y);
        return new Point(
            (int)Math.Round(x * (double)W / surface.Width),
            (int)Math.Round(y * (double)H / surface.Height));
    }

    private sealed class LoginDialog : Form
    {
        private readonly TextBox idField;
        private readonly TextBox pwField;
        private readonly Label message;
        private readonly Button okButton;
        private readonly Form self;

        public LoginDialog()
        {
            self = this;
            Text = T("Connexion REC BLUE", "REC BLUE login", "Inicio de sesión REC BLUE", "Вход в REC BLUE", "REC BLUE-Anmeldung", "تسجيل الدخول إلى REC BLUE", "REC BLUE 登录", "Accesso REC BLUE", "Autentificare REC BLUE", "REC BLUE bejelentkezés");
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            ClientSize = new Size(372, 272);
            MaximizeBox = false;
            MinimizeBox = false;
            ShowIcon = false;
            BackColor = Color.FromArgb(30, 38, 54);
            ForeColor = Color.White;
            Font = new Font("Segoe UI", 10f);

            Color field = Color.FromArgb(44, 54, 74);

            Label title = new Label();
            title.Text = T("Compte REC BLUE", "REC BLUE account", "Cuenta REC BLUE", "Аккаунт REC BLUE", "REC BLUE-Konto", "حساب REC BLUE", "REC BLUE 账号", "Account REC BLUE", "Cont REC BLUE", "REC BLUE-fiók");
            title.Font = new Font("Segoe UI", 13f, FontStyle.Bold);
            title.ForeColor = Color.White;
            title.SetBounds(20, 14, 330, 28);
            Controls.Add(title);

            Label l1 = new Label();
            l1.Text = T("Pseudo ou adresse email", "Nickname or email", "Apodo o correo", "Псевдоним или почта", "Name oder E-Mail", "الاسم أو البريد الإلكتروني", "昵称或邮箱", "Nome o email", "Poreclă sau email", "Becenév vagy e-mail");
            l1.ForeColor = Color.FromArgb(205, 215, 235);
            l1.SetBounds(20, 52, 330, 18);
            Controls.Add(l1);

            idField = new TextBox();
            idField.SetBounds(20, 72, 330, 26);
            idField.BackColor = field;
            idField.ForeColor = Color.White;
            idField.BorderStyle = BorderStyle.FixedSingle;
            idField.MaxLength = 254;
            Controls.Add(idField);

            Label l2 = new Label();
            l2.Text = T("Mot de passe", "Password", "Contraseña", "Пароль", "Passwort", "كلمة المرور", "密码", "Password", "Parolă", "Jelszó");
            l2.ForeColor = Color.FromArgb(205, 215, 235);
            l2.SetBounds(20, 110, 330, 18);
            Controls.Add(l2);

            pwField = new TextBox();
            pwField.SetBounds(20, 130, 330, 26);
            pwField.BackColor = field;
            pwField.ForeColor = Color.White;
            pwField.BorderStyle = BorderStyle.FixedSingle;
            pwField.MaxLength = 128;
            pwField.UseSystemPasswordChar = true;
            Controls.Add(pwField);

            message = new Label();
            message.Text = "";
            message.ForeColor = Color.FromArgb(255, 170, 170);
            message.SetBounds(20, 162, 330, 34);
            Controls.Add(message);

            okButton = new Button();
            okButton.Text = T("Se connecter", "Log in", "Iniciar sesión", "Войти", "Anmelden", "تسجيل الدخول", "登录", "Accedi", "Autentificare", "Bejelentkezés");
            okButton.SetBounds(20, 202, 160, 34);
            okButton.FlatStyle = FlatStyle.Flat;
            okButton.BackColor = Color.FromArgb(36, 69, 184);
            okButton.ForeColor = Color.White;
            okButton.FlatAppearance.BorderColor = Color.FromArgb(90, 120, 220);
            Controls.Add(okButton);

            Button forgot = new Button();
            forgot.Text = T("Mot de passe oublie ?", "Forgot password?", "¿Olvidaste la contraseña?", "Забыли пароль?", "Passwort vergessen?", "هل نسيت كلمة المرور؟", "忘记密码？", "Password dimenticata?", "Ai uitat parola?", "Elfelejtetted a jelszót?");
            forgot.SetBounds(190, 202, 162, 34);
            forgot.FlatStyle = FlatStyle.Flat;
            forgot.BackColor = Color.FromArgb(46, 58, 82);
            forgot.ForeColor = Color.White;
            forgot.FlatAppearance.BorderColor = Color.FromArgb(90, 120, 220);
            Controls.Add(forgot);

            AcceptButton = okButton;
            forgot.Click += delegate { Process.Start("https://recblue.net/compte"); };
            okButton.Click += delegate { TryConnect(); };
        }

        private void TryConnect()
        {
            if (idField.Text.Trim() == "")
            {
                message.Text = T("Indique ton pseudo ou ton adresse email.", "Enter your nickname or email.", "Indica tu apodo o correo.", "Укажите псевдоним или почту.", "Gib Name oder E-Mail an.", "أدخل اسمك أو بريدك الإلكتروني.", "请输入昵称或邮箱。", "Indica nome o email.", "Indică porecla sau emailul.", "Add meg a becenevet vagy az e-mailt.");
                return;
            }
            if (pwField.Text == "")
            {
                message.Text = T("Indique ton mot de passe.", "Enter your password.", "Indica tu contraseña.", "Введите пароль.", "Gib dein Passwort ein.", "أدخل كلمة المرور.", "请输入密码。", "Inserisci la password.", "Introdu parola.", "Add meg a jelszót.");
                return;
            }
            okButton.Enabled = false;
            message.Text = T("Connexion...", "Signing in...", "Conectando...", "Вход...", "Anmeldung...", "جارٍ تسجيل الدخول...", "正在登录...", "Accesso...", "Autentificare...", "Bejelentkezés...");
            self.Refresh();
            string error = ConnectAccount(idField.Text, pwField.Text);
            if (error == "")
            {
                Tag = "ok";
                Close();
                return;
            }
            message.Text = error;
            pwField.Text = "";
            okButton.Enabled = true;
        }
    }

    // Saisie du code d'acces quand la maintenance est active et que le compte n'est
    // pas administrateur.
    private sealed class MaintenanceDialog : Form
    {
        internal string Code = "";

        internal MaintenanceDialog(string message, string error)
        {
            Text = MaintText("Maintenance du jeu", "Game maintenance");
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            ClientSize = new Size(452, 256);
            MaximizeBox = false;
            MinimizeBox = false;
            ShowIcon = false;
            ShowInTaskbar = false;
            BackColor = Color.FromArgb(30, 38, 54);
            ForeColor = Color.White;
            Font = new Font("Segoe UI", 10f);

            Label title = new Label();
            title.Text = MaintText("Le jeu est en maintenance", "The game is under maintenance");
            title.Font = new Font("Segoe UI", 13f, FontStyle.Bold);
            title.SetBounds(20, 14, 410, 28);
            Controls.Add(title);

            Label info = new Label();
            info.Text = message;
            info.ForeColor = Color.FromArgb(205, 215, 235);
            info.SetBounds(20, 50, 410, 44);
            Controls.Add(info);

            Label label = new Label();
            label.Text = MaintText("Code d’acces", "Access code");
            label.ForeColor = Color.FromArgb(205, 215, 235);
            label.SetBounds(20, 102, 410, 18);
            Controls.Add(label);

            TextBox box = new TextBox();
            box.SetBounds(20, 122, 410, 26);
            box.BackColor = Color.FromArgb(44, 54, 74);
            box.ForeColor = Color.White;
            box.BorderStyle = BorderStyle.FixedSingle;
            box.MaxLength = 40;
            box.CharacterCasing = CharacterCasing.Upper;
            Controls.Add(box);

            Label feedback = new Label();
            feedback.Text = error;
            feedback.ForeColor = Color.FromArgb(255, 170, 170);
            feedback.SetBounds(20, 156, 410, 30);
            Controls.Add(feedback);

            Button ok = new Button();
            ok.Text = MaintText("Entrer", "Enter");
            ok.SetBounds(20, 202, 196, 34);
            ok.FlatStyle = FlatStyle.Flat;
            ok.BackColor = Color.FromArgb(36, 69, 184);
            ok.ForeColor = Color.White;
            ok.FlatAppearance.BorderColor = Color.FromArgb(90, 120, 220);
            Controls.Add(ok);

            Button cancel = new Button();
            cancel.Text = MaintText("Annuler", "Cancel");
            cancel.SetBounds(234, 202, 196, 34);
            cancel.FlatStyle = FlatStyle.Flat;
            cancel.BackColor = Color.FromArgb(46, 58, 82);
            cancel.ForeColor = Color.White;
            cancel.FlatAppearance.BorderColor = Color.FromArgb(90, 120, 220);
            Controls.Add(cancel);

            AcceptButton = ok;
            CancelButton = cancel;
            Shown += delegate { box.Focus(); };
            ok.Click += delegate
            {
                string value = box.Text.Trim();
                if (value == "")
                {
                    feedback.Text = MaintText("Entre le code d’acces.", "Enter the access code.");
                    return;
                }
                Code = value;
                DialogResult = DialogResult.OK;
                Close();
            };
            cancel.Click += delegate
            {
                DialogResult = DialogResult.Cancel;
                Close();
            };
        }
    }

    // Choix de la langue : les dix langues du site, dans leur propre ecriture.
    private sealed class LanguageDialog : Form
    {
        public string PickedCode;

        public LanguageDialog()
        {
            Text = T("Langue", "Language", "Idioma", "Язык", "Sprache", "اللغة", "语言", "Lingua", "Limbă", "Nyelv");
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            ClientSize = new Size(320, 316);
            MaximizeBox = false;
            MinimizeBox = false;
            ShowIcon = false;
            BackColor = Color.FromArgb(30, 38, 54);
            ForeColor = Color.White;
            Font = new Font("Segoe UI", 10f);

            ListBox list = new ListBox();
            list.SetBounds(16, 16, 288, 232);
            list.BackColor = Color.FromArgb(44, 54, 74);
            list.ForeColor = Color.White;
            list.BorderStyle = BorderStyle.FixedSingle;
            list.Font = new Font("Segoe UI", 11f);
            for (int i = 0; i < LangNames.Length; i++) list.Items.Add(LangNames[i]);
            list.SelectedIndex = LangIndex;
            Controls.Add(list);

            Button ok = new Button();
            ok.Text = T("Choisir", "Choose", "Elegir", "Выбрать", "Wählen", "اختيار", "选择", "Scegli", "Alege", "Kiválaszt");
            ok.SetBounds(16, 262, 150, 34);
            ok.FlatStyle = FlatStyle.Flat;
            ok.BackColor = Color.FromArgb(36, 69, 184);
            ok.ForeColor = Color.White;
            ok.FlatAppearance.BorderColor = Color.FromArgb(90, 120, 220);
            ok.DialogResult = DialogResult.OK;
            Controls.Add(ok);

            Button cancel = new Button();
            cancel.Text = T("Annuler", "Cancel", "Cancelar", "Отмена", "Abbrechen", "إلغاء", "取消", "Annulla", "Anulează", "Mégse");
            cancel.SetBounds(178, 262, 126, 34);
            cancel.FlatStyle = FlatStyle.Flat;
            cancel.BackColor = Color.FromArgb(46, 58, 82);
            cancel.ForeColor = Color.White;
            cancel.FlatAppearance.BorderColor = Color.FromArgb(90, 120, 220);
            cancel.DialogResult = DialogResult.Cancel;
            Controls.Add(cancel);

            AcceptButton = ok;
            CancelButton = cancel;
            ok.Click += delegate
            {
                if (list.SelectedIndex >= 0) PickedCode = LangCodes[list.SelectedIndex];
            };
        }
    }

    // ---- installateur REC BLUE -----------------------------------------------
    // Le launcher ne distribue pas Rec Room : il detecte une installation existante,
    // verifie ses fichiers, puis ajoute uniquement le pack du serveur.
    private sealed class InstallerDialog : Form
    {
        private readonly TextBox pathField;
        private readonly Label info;
        private readonly Button installButton;

        public InstallerDialog()
        {
            Text = T("Installer REC BLUE", "Install REC BLUE", "Instalar REC BLUE", "Установить REC BLUE", "REC BLUE installieren", "تثبيت REC BLUE", "安装 REC BLUE", "Installa REC BLUE", "Instalează REC BLUE", "REC BLUE telepítése");
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            ClientSize = new Size(640, 360);
            MaximizeBox = false;
            MinimizeBox = false;
            ShowIcon = false;
            BackColor = Color.FromArgb(30, 38, 54);
            ForeColor = Color.White;
            Font = new Font("Segoe UI", 10f);

            Label title = new Label();
            title.Text = T("Installer REC BLUE", "Install REC BLUE", "Instalar REC BLUE", "Установить REC BLUE", "REC BLUE installieren", "تثبيت REC BLUE", "安装 REC BLUE", "Installa REC BLUE", "Instalează REC BLUE", "REC BLUE telepítése");
            title.Font = new Font("Segoe UI", 14f, FontStyle.Bold);
            title.SetBounds(20, 14, 600, 28);
            Controls.Add(title);

            Label description = new Label();
            description.Text = T(
                "REC BLUE utilise une installation Rec Room existante et n'ajoute que le pack du serveur. Le jeu n'est ni telecharge ni copie : installe-le d'abord via Steam ou recroom.com/download.",
                "REC BLUE uses an existing Rec Room installation and only adds the server pack. The game is not downloaded or copied: install it first through Steam or recroom.com/download.",
                "REC BLUE usa una instalación existente de Rec Room y solo añade el pack del servidor. El juego no se descarga ni se copia: instálalo primero desde Steam o recroom.com/download.",
                "REC BLUE использует существующую установку Rec Room и добавляет только серверный пакет. Игра не скачивается и не копируется: установите её через Steam или recroom.com/download.",
                "REC BLUE nutzt eine vorhandene Rec Room-Installation und fügt nur das Serverpaket hinzu. Das Spiel wird weder heruntergeladen noch kopiert: Installiere es zuerst über Steam oder recroom.com/download.",
                "يستخدم REC BLUE تثبيت Rec Room الموجود ويضيف حزمة الخادم فقط. لا يتم تنزيل اللعبة أو نسخها: ثبّتها أولاً عبر Steam أو recroom.com/download.",
                "REC BLUE 使用现有的 Rec Room 安装，只添加服务器包。游戏不会被下载或复制：请先通过 Steam 或 recroom.com/download 安装。",
                "REC BLUE usa un'installazione esistente di Rec Room e aggiunge solo il pacchetto del server. Il gioco non viene scaricato né copiato: installalo prima da Steam o recroom.com/download.",
                "REC BLUE folosește o instalare Rec Room existentă și adaugă doar pachetul serverului. Jocul nu este descărcat sau copiat: instalează-l mai întâi prin Steam sau recroom.com/download.",
                "A REC BLUE egy meglévő Rec Room-telepítést használ, és csak a szervercsomagot adja hozzá. A játék nem töltődik le és nem másolódik: először telepítsd Steamen vagy a recroom.com/download oldalon.");
            description.ForeColor = Color.FromArgb(200, 212, 234);
            description.SetBounds(20, 48, 600, 68);
            Controls.Add(description);

            Label pathLabel = new Label();
            pathLabel.Text = T("Dossier de Rec Room :", "Rec Room folder:", "Carpeta de Rec Room:", "Папка Rec Room:", "Rec Room-Ordner:", "مجلد Rec Room:", "Rec Room 文件夹：", "Cartella di Rec Room:", "Folderul Rec Room:", "Rec Room mappa:");
            pathLabel.ForeColor = Color.FromArgb(200, 212, 234);
            pathLabel.SetBounds(20, 122, 600, 20);
            Controls.Add(pathLabel);

            pathField = new TextBox();
            pathField.SetBounds(20, 144, 600, 26);
            pathField.ReadOnly = true;
            pathField.BackColor = Color.FromArgb(44, 54, 74);
            pathField.ForeColor = Color.White;
            pathField.BorderStyle = BorderStyle.FixedSingle;
            Controls.Add(pathField);

            info = new Label();
            info.SetBounds(20, 178, 600, 56);
            info.ForeColor = Color.FromArgb(170, 188, 214);
            Controls.Add(info);

            Button detect = MakeInstallerButton(T("Detecter", "Detect", "Detectar", "Найти", "Suchen", "اكتشاف", "检测", "Rileva", "Detectează", "Felderítés"), 20, 244, 120);
            detect.Click += delegate { Detect(); };
            Controls.Add(detect);

            Button browse = MakeInstallerButton(T("Parcourir...", "Browse...", "Examinar...", "Обзор...", "Durchsuchen...", "استعراض...", "浏览...", "Sfoglia...", "Răsfoiește...", "Tallózás..."), 150, 244, 120);
            browse.Click += delegate { Browse(); };
            Controls.Add(browse);

            Button official = MakeInstallerButton(T("Obtenir Rec Room", "Get Rec Room", "Obtener Rec Room", "Получить Rec Room", "Rec Room holen", "الحصول على Rec Room", "获取 Rec Room", "Ottieni Rec Room", "Obține Rec Room", "Rec Room beszerzése"), 280, 244, 190);
            official.Click += delegate { Process.Start("https://recroom.com/download"); };
            Controls.Add(official);

            installButton = MakeInstallerButton(T("Installer", "Install", "Instalar", "Установить", "Installieren", "تثبيت", "安装", "Installa", "Instalează", "Telepítés"), 440, 302, 160);
            installButton.BackColor = Color.FromArgb(36, 69, 184);
            installButton.Click += delegate { Install(); };
            Controls.Add(installButton);

            Button later = MakeInstallerButton(T("Plus tard", "Later", "Más tarde", "Позже", "Später", "لاحقاً", "稍后", "Più tardi", "Mai târziu", "Később"), 20, 302, 130);
            later.Click += delegate { DialogResult = DialogResult.Cancel; Close(); };
            Controls.Add(later);
            CancelButton = later;

            Detect();
        }

        private static Button MakeInstallerButton(string text, int x, int y, int width)
        {
            Button button = new Button();
            button.Text = text;
            button.SetBounds(x, y, width, 36);
            button.FlatStyle = FlatStyle.Flat;
            button.BackColor = Color.FromArgb(46, 58, 82);
            button.ForeColor = Color.White;
            button.FlatAppearance.BorderColor = Color.FromArgb(90, 120, 220);
            return button;
        }

        private void Detect()
        {
            // Le profil 2025 n'a pas de detection Steam : on propose son dossier dedie
            // des qu'il existe, sinon la detection habituelle.
            string current = Selected.ScanSteam
                ? FindGameInstall()
                : (Directory.Exists(GameDir) ? GameDir : FindGameInstall());
            ShowPath(current);
        }

        private void ShowPath(string path)
        {
            pathField.Text = path == null ? "" : path;
            bool valid = IsGameFolder(path);
            installButton.Enabled = valid;
            if (valid)
            {
                info.ForeColor = Color.FromArgb(120, 235, 160);
                info.Text = T("Installation Rec Room valide detectee. Clique sur Installer pour ajouter REC BLUE.", "Valid Rec Room installation found. Click Install to add REC BLUE.", "Instalación válida de Rec Room detectada. Pulsa Instalar para añadir REC BLUE.", "Найдена действительная установка Rec Room. Нажмите «Установить», чтобы добавить REC BLUE.", "Gültige Rec Room-Installation gefunden. Klicke auf Installieren, um REC BLUE hinzuzufügen.", "تم العثور على تثبيت Rec Room صالح. اضغط تثبيت لإضافة REC BLUE.", "已找到有效的 Rec Room 安装。点击安装以添加 REC BLUE。", "Installazione valida di Rec Room trovata. Premi Installa per aggiungere REC BLUE.", "Instalare Rec Room validă detectată. Apasă Instalează pentru a adăuga REC BLUE.", "Érvényes Rec Room-telepítés található. Kattints a Telepítés gombra a REC BLUE hozzáadásához.");
            }
            else if (string.IsNullOrEmpty(path))
            {
                info.ForeColor = Color.FromArgb(205, 212, 234);
                info.Text = T("Rec Room n'a pas ete trouve. Choisis le dossier du jeu ou installe-le depuis les canaux officiels.", "Rec Room was not found. Choose the game folder or install it from the official sources.", "No se encontró Rec Room. Elige la carpeta del juego o instálalo desde las fuentes oficiales.", "Rec Room не найден. Выберите папку игры или установите её из официальных источников.", "Rec Room wurde nicht gefunden. Wähle den Spielordner oder installiere es aus offiziellen Quellen.", "لم يتم العثور على Rec Room. اختر مجلد اللعبة أو ثبّتها من المصادر الرسمية.", "未找到 Rec Room。请选择游戏文件夹，或从官方渠道安装。", "Rec Room non trovato. Scegli la cartella del gioco o installalo dalle fonti ufficiali.", "Rec Room nu a fost găsit. Alege folderul jocului sau instalează-l din sursele oficiale.", "A Rec Room nem található. Válaszd ki a játékmappát, vagy telepítsd hivatalos forrásból.");
            }
            else
            {
                info.ForeColor = Color.FromArgb(255, 170, 170);
                info.Text = T("Ce dossier ne contient pas une installation Rec Room valide (RecRoom.exe, GameAssembly.dll et API Steam requis).", "This folder does not contain a valid Rec Room installation (RecRoom.exe, GameAssembly.dll and the Steam API are required).", "Esta carpeta no contiene una instalación válida de Rec Room (se requieren RecRoom.exe, GameAssembly.dll y la API de Steam).", "В этой папке нет действительной установки Rec Room (нужны RecRoom.exe, GameAssembly.dll и Steam API).", "Dieser Ordner enthält keine gültige Rec Room-Installation (RecRoom.exe, GameAssembly.dll und Steam-API erforderlich).", "لا يحتوي هذا المجلد على تثبيت Rec Room صالح (مطلوب RecRoom.exe وGameAssembly.dll وSteam API).", "此文件夹没有有效的 Rec Room 安装（需要 RecRoom.exe、GameAssembly.dll 和 Steam API）。", "Questa cartella non contiene un'installazione valida di Rec Room (servono RecRoom.exe, GameAssembly.dll e l'API Steam).", "Acest folder nu conține o instalare Rec Room validă (sunt necesare RecRoom.exe, GameAssembly.dll și API-ul Steam).", "Ez a mappa nem tartalmaz érvényes Rec Room-telepítést (RecRoom.exe, GameAssembly.dll és Steam API szükséges).");
            }
        }

        private void Browse()
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = T("Dossier de Rec Room (celui qui contient RecRoom.exe)", "Rec Room folder (the one containing RecRoom.exe)", "Carpeta de Rec Room (la que contiene RecRoom.exe)", "Папка Rec Room (та, где лежит RecRoom.exe)", "Rec Room-Ordner (der mit RecRoom.exe)", "مجلد Rec Room (الذي يحتوي على RecRoom.exe)", "Rec Room 文件夹（包含 RecRoom.exe）", "Cartella di Rec Room (quella con RecRoom.exe)", "Folderul Rec Room (cel care conține RecRoom.exe)", "Rec Room mappa (amelyikben a RecRoom.exe van)");
                dialog.ShowNewFolderButton = false;
                try { if (Directory.Exists(pathField.Text)) dialog.SelectedPath = pathField.Text; }
                catch { }
                if (dialog.ShowDialog(this) == DialogResult.OK) ShowPath(dialog.SelectedPath);
            }
        }

        private void Install()
        {
            if (!IsGameFolder(pathField.Text))
            {
                ShowPath(pathField.Text);
                return;
            }
            ApplyGameDir(pathField.Text);
            SaveConfig();
            DialogResult = DialogResult.OK;
            Close();
        }
    }

    private static void ShowInstaller(Form owner)
    {
        using (InstallerDialog dialog = new InstallerDialog())
        {
            if (dialog.ShowDialog(owner) == DialogResult.OK)
            {
                Status = T("Installation de REC BLUE...", "Installing REC BLUE...", "Instalando REC BLUE...", "Установка REC BLUE...", "REC BLUE wird installiert...", "جارٍ تثبيت REC BLUE...", "正在安装 REC BLUE...", "Installazione di REC BLUE...", "Se instalează REC BLUE...", "REC BLUE telepítése...");
                WriteLog("installation dans : " + GameDir);
                InstallPack(owner, false);
            }
        }
    }

    // ---- installation du pack (plugin seulement) -----------------------------
    private const string DefaultPackUrl = "https://recblue.net/download/rec-blue-pack.json";
    private const string PackRoot = "https://recblue.net/";
    private const string BepInExLoaderUrl = "https://builds.bepinex.dev/projects/bepinex_be/791/BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.791%2Bb782da4.zip";
    private const string BepInExLoaderSha = "bb1c510909b69522733791f3a0817a487379a52da6468a492f1c9c19b3ec6f9a";

    // ---- fichiers du jeu (client d'origine) ----------------------------------
    // Rec Room a ferme le 1er juin 2026 et n'est plus vendu nulle part : un nouveau
    // joueur n'a aucun moyen de se procurer le client. Quand le dossier du jeu est
    // absent, le launcher peut donc poser l'archive des fichiers : telechargement,
    // verification de l'empreinte, extraction, puis installation du pack par-dessus.
    // Aucun fichier du jeu n'est embarque dans l'exe : seule l'adresse de l'archive
    // l'est. Une URL vide desactive la fonction (le launcher redemande un dossier
    // existant, comme avant).
    // En lecture seule et non const : une constante vide ferait passer tout le bloc
    // pour du code inatteignable et le compilateur le signalerait a chaque build.
    private const string DefaultGameArchiveUrl = "https://cdn.recblue.net/data/rec-blue/rec-room-2023.zip";
    private static readonly string GameArchiveUrl = DefaultGameArchiveUrl;
    private const string GameArchiveSha = "2f29c64e5374247abbf1f73c4b33440a0e5b7ace8300ef65b81839499e33a967";
    private const string GameArchiveRoot = "RecRoom2023";   // dossier racine dans l'archive
    // L'archive est publiee en parties : wrangler refuse d'envoyer un objet de plus de
    // 300 Mio. Le decoupage sert aussi la reprise, qui redemarre au pire une partie.
    private const long GameArchivePartBytes = 256L * 1024 * 1024;
    private const int GameArchiveParts = 18;
    private const long GameArchiveBytes = 4570205766L;   // taille exacte du zip publie
    internal static string PackUrl = DefaultPackUrl;
    internal static bool Installing;
    // Le pack vient d etre installe pour un clic sur JOUER : on enchaine le lancement.
    internal static bool LaunchAfterInstall;

    internal static void InstallPack(Form owner, bool automatic)
    {
        if (Installing)
        {
            Status = T("Installation deja en cours...", "Installation already running...", "Instalación ya en curso...", "Установка уже идёт...", "Installation läuft bereits...", "التثبيت جارٍ بالفعل...", "安装已在进行中...", "Installazione già in corso...", "Instalare deja în curs...", "A telepítés már folyamatban...");
            return;
        }
        if (GameRunning())
        {
            Status = T("Rec Room tourne : ferme-le avant d'installer.", "Rec Room is running: close it before installing.", "Rec Room está abierto: ciérralo antes de instalar.", "Rec Room запущен: закройте его перед установкой.", "Rec Room läuft: schließe es vor der Installation.", "Rec Room يعمل: أغلقه قبل التثبيت.", "Rec Room 正在运行：请关闭后再安装。", "Rec Room è in esecuzione: chiudilo prima di installare.", "Rec Room rulează: închide-l înainte de instalare.", "A Rec Room fut: zárd be a telepítés előtt.");
            WriteLog(Status);
            return;
        }
        if (!IsGameFolder(GameDir))
        {
            if (GameArchiveUrl == "")
            {
                Status = T("Rec Room introuvable - choisis d'abord son dossier.", "Rec Room not found - choose its folder first.", "Rec Room no encontrado: elige primero su carpeta.", "Rec Room не найден — сначала выберите его папку.", "Rec Room nicht gefunden – wähle zuerst den Ordner.", "لم يتم العثور على Rec Room - اختر مجلده أولاً.", "未找到 Rec Room，请先选择其文件夹。", "Rec Room non trovato: scegli prima la cartella.", "Rec Room nu a fost găsit - alege mai întâi folderul.", "A Rec Room nem található – válaszd ki először a mappáját.");
                if (owner != null) ShowInstaller(owner);
                return;
            }
            // Le jeu n'est plus vendu : le launcher pose ses fichiers avant le pack.
            // Une seule confirmation pour les deux, sinon le joueur en voit deux.
            if (!automatic)
            {
                DialogResult go = MessageBox.Show(owner,
                    T("Rec Room n'est plus vendu : ses fichiers ne sont sur aucune boutique.", "Rec Room is no longer sold: none of its files are in a store.", "Rec Room ya no se vende: sus archivos no están en ninguna tienda.", "Rec Room больше не продаётся: его файлов нет ни в одном магазине.", "Rec Room wird nicht mehr verkauft: seine Dateien gibt es in keinem Shop.", "لم يعد Rec Room يُباع: ملفاته ليست في أي متجر.", "Rec Room 已停止销售：其文件不在任何商店中。", "Rec Room non è più in vendita: i suoi file non sono in nessuno store.", "Rec Room nu se mai vinde: fișierele sale nu sunt în niciun magazin.", "A Rec Room már nem kapható: a fájljai egyik boltban sincsenek.") +
                    "\n\n" +
                    T("Le launcher va les telecharger (environ 4,3 Go) et les poser dans :", "The launcher will download them (about 4.3 GB) and place them in:", "El launcher los descargará (unos 4,3 GB) y los pondrá en:", "Лаунчер скачает их (около 4,3 ГБ) и разместит в:", "Der Launcher lädt sie herunter (etwa 4,3 GB) und legt sie ab in:", "سيقوم المشغّل بتنزيلها (حوالي 4,3 غيغابايت) ووضعها في:", "启动器将下载它们（约 4.3 GB）并放到：", "Il launcher li scaricherà (circa 4,3 GB) e li metterà in:", "Launcherul le va descărca (aproximativ 4,3 GB) și le va pune în:", "A launcher letölti őket (kb. 4,3 GB), és ide teszi:") +
                    "\n" + DefaultInstallRoot() + "\n\n" +
                    T("Ensuite le pack REC BLUE s'installe par-dessus.", "The REC BLUE pack is then installed on top.", "Después se instala encima el pack REC BLUE.", "Затем сверху устанавливается пакет REC BLUE.", "Danach wird das REC BLUE-Paket darüber installiert.", "ثم تُثبّت حزمة REC BLUE فوقها.", "随后在其上安装 REC BLUE 包。", "Poi il pacchetto REC BLUE viene installato sopra.", "Apoi pachetul REC BLUE este instalat deasupra.", "Ezután a REC BLUE csomag telepítése következik."),
                    T("Installer le jeu", "Install the game", "Instalar el juego", "Установить игру", "Spiel installieren", "تثبيت اللعبة", "安装游戏", "Installa il gioco", "Instalează jocul", "Játék telepítése"),
                    MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
                if (go != DialogResult.Yes) return;
                // La confirmation couvre le jeu et le pack : pas de seconde fenetre.
                automatic = true;
            }
        }

        DialogResult answer = automatic ? DialogResult.Yes : MessageBox.Show(owner,
            T("Installer le pack REC BLUE dans :", "Install the REC BLUE pack into:", "Instalar el pack REC BLUE en:", "Установить пакет REC BLUE в:", "REC BLUE-Paket installieren in:", "تثبيت حزمة REC BLUE في:", "将 REC BLUE 包安装到：", "Installare il pacchetto REC BLUE in:", "Instalează pachetul REC BLUE în:", "A REC BLUE csomag telepítése ide:") +
            "\n" + GameDir + "\n\n" +
            (Selected.Injector
                ? MaintText("Aucun fichier du jeu n'est telecharge ni copie. Le pack ajoute le patch 2025, l'injecteur et sa configuration.", "No game file is downloaded or copied. The pack adds the 2025 patch, the injector and its configuration.")
                : T("Aucun fichier du jeu n'est telecharge ni copie. Le pack ajoute BepInEx, le plugin serveur et sa configuration.", "No game file is downloaded or copied. The pack adds BepInEx, the server plugin and its configuration.", "No se descarga ni copia ningún archivo del juego. El pack añade BepInEx, el plugin del servidor y su configuración.", "Ни один файл игры не скачивается и не копируется. Пакет добавляет BepInEx, серверный плагин и его настройки.", "Keine Spieldatei wird heruntergeladen oder kopiert. Das Paket fügt BepInEx, das Server-Plugin und seine Konfiguration hinzu.", "لا يتم تنزيل أو نسخ أي ملف من اللعبة. تضيف الحزمة BepInEx وإضافة الخادم وإعداداته.", "不会下载或复制任何游戏文件。此包会添加 BepInEx、服务器插件及其配置。", "Nessun file del gioco viene scaricato o copiato. Il pacchetto aggiunge BepInEx, il plugin del server e la sua configurazione.", "Niciun fișier al jocului nu este descărcat sau copiat. Pachetul adaugă BepInEx, pluginul serverului și configurația sa.", "A játék egyetlen fájlja sem töltődik le vagy másolódik. A csomag a BepInEx-et, a szerverplugint és annak beállításait adja hozzá.")),
            T("Installer REC BLUE", "Install REC BLUE", "Instalar REC BLUE", "Установить REC BLUE", "REC BLUE installieren", "تثبيت REC BLUE", "安装 REC BLUE", "Installa REC BLUE", "Instalează REC BLUE", "REC BLUE telepítése"),
            MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
        if (answer != DialogResult.Yes) return;

        Installing = true;
        Status = T("Preparation de l'installation...", "Preparing the installation...", "Preparando la instalación...", "Подготовка установки...", "Installation wird vorbereitet...", "جارٍ تحضير التثبيت...", "正在准备安装...", "Preparazione dell'installazione...", "Se pregătește instalarea...", "A telepítés előkészítése...");
        WriteLog(Status);

        System.Threading.Thread worker = new System.Threading.Thread(delegate()
        {
            try { RunInstall(owner); }
            catch (Exception error)
            {
                Status = T("Echec de l'installation : ", "Installation failed: ", "Error de instalación: ", "Ошибка установки: ", "Installation fehlgeschlagen: ", "فشل التثبيت: ", "安装失败：", "Installazione non riuscita: ", "Instalare eșuată: ", "Sikertelen telepítés: ") + error.Message;
                WriteLog(Status);
            }
            finally
            {
                Installing = false;
                Refresh(owner);
                if (LaunchAfterInstall)
                {
                    LaunchAfterInstall = false;
                    // Le joueur a demande le jeu : le pack vient d etre pose, on lance.
                    StartGame(false);
                }
            }
        });
        worker.IsBackground = true;
        worker.Start();
    }

    // Dossier ou le launcher pose le jeu quand le joueur n'en a pas. La racine de C:
    // n'est pas inscriptible sans droits administrateur : le profil du joueur, si.
    private static string DefaultInstallRoot()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "REC BLUE");
    }

    // Espace libre du disque qui porte le dossier, en octets. -1 si indeterminable.
    private static long FreeBytesFor(string dir)
    {
        try
        {
            string root = Path.GetPathRoot(Path.GetFullPath(dir));
            if (string.IsNullOrEmpty(root)) return -1;
            return new DriveInfo(root).AvailableFreeSpace;
        }
        catch { return -1; }
    }

    // Pose les fichiers du jeu quand le dossier est absent : telechargement, empreinte
    // SHA-256, extraction. Renvoie false si rien n'a pu etre pose, pour que l'appelant
    // s'arrete sans toucher au pack.
    private static bool EnsureGameFiles(Form owner)
    {
        if (IsGameFolder(GameDir)) return true;
        if (GameArchiveUrl == "")
        {
            Status = T("Le jeu n'est pas installe : ses fichiers ne sont pas encore publies.", "The game is not installed: its files are not published yet.", "El juego no está instalado: sus archivos aún no están publicados.", "Игра не установлена: её файлы ещё не опубликованы.", "Das Spiel ist nicht installiert: seine Dateien sind noch nicht veröffentlicht.", "اللعبة غير مثبتة: ملفاتها لم تُنشر بعد.", "游戏未安装：其文件尚未发布。", "Il gioco non è installato: i suoi file non sono ancora pubblicati.", "Jocul nu este instalat: fișierele sale nu sunt încă publicate.", "A játék nincs telepítve: a fájljai még nincsenek közzétéve.");
            WriteLog("archive du jeu : aucune adresse configuree");
            return false;
        }

        string root;
        try
        {
            root = DefaultInstallRoot();
            Directory.CreateDirectory(root);
        }
        catch (Exception error)
        {
            Status = T("Dossier d'installation inaccessible : ", "Install folder not writable: ", "Carpeta de instalación no accesible: ", "Папка установки недоступна: ", "Installationsordner nicht beschreibbar: ", "مجلد التثبيت غير متاح: ", "安装文件夹不可写：", "Cartella di installazione non accessibile: ", "Folderul de instalare nu este accesibil: ", "A telepítési mappa nem írható: ") + error.Message;
            WriteLog(Status);
            return false;
        }

        string zip = Path.Combine(root, "rec-room-2023.zip");
        long free = FreeBytesFor(root);
        // Le jeu extrait pese environ le double de l'archive : il faut la place des deux.
        long needed = (GameArchiveBytes * 2L) + (256L * 1024 * 1024);
        if (free >= 0 && free < needed)
        {
            Status = T("Espace insuffisant pour installer le jeu : il faut environ ", "Not enough space to install the game: about ", "Espacio insuficiente para instalar el juego: se necesitan unos ", "Недостаточно места для установки игры: нужно около ", "Nicht genug Speicherplatz für das Spiel: etwa ", "مساحة غير كافية لتثبيت اللعبة: يلزم حوالي ", "安装游戏的空间不足：需要约 ", "Spazio insufficiente per installare il gioco: servono circa ", "Spațiu insuficient pentru instalarea jocului: sunt necesari circa ", "Nincs elég hely a játék telepítéséhez: körülbelül ") +
                ((needed + (1024L * 1024 * 1024) - 1) / (1024L * 1024 * 1024)) + " Go.";
            WriteLog(Status + " (libre : " + (free / (1024L * 1024 * 1024)) + " Go) sur " + root);
            return false;
        }

        SetStatus(owner, T("Telechargement des fichiers du jeu...", "Downloading the game files...", "Descargando los archivos del juego...", "Загрузка файлов игры...", "Spieldateien werden heruntergeladen...", "جارٍ تنزيل ملفات اللعبة...", "正在下载游戏文件...", "Download dei file del gioco...", "Se descarcă fișierele jocului...", "A játékfájlok letöltése..."));
        WriteLog("archive du jeu : " + GameArchiveUrl);
        FetchParts(owner, GameArchiveUrl, zip, T("Jeu", "Game", "Juego", "Игра", "Spiel", "اللعبة", "游戏", "Gioco", "Joc", "Játék"));

        string got = Sha256Of(zip);
        if (GameArchiveSha != "" && got != GameArchiveSha.ToLowerInvariant())
        {
            try { File.Delete(zip); } catch { }
            Status = T("Archive du jeu corrompue : empreinte differente.", "Game archive is corrupted: checksum mismatch.", "Archivo del juego corrupto: la huella no coincide.", "Архив игры повреждён: хеш не совпадает.", "Spielarchiv beschädigt: Prüfsumme stimmt nicht.", "أرشيف اللعبة تالف: البصمة غير مطابقة.", "游戏存档已损坏：校验值不一致。", "Archivio del gioco corrotto: impronta diversa.", "Arhiva jocului este coruptă: amprenta nu corespunde.", "A játékarchív sérült: az ellenőrzőösszeg nem egyezik.");
            WriteLog(Status + " obtenu " + got + ", attendu " + GameArchiveSha);
            return false;
        }
        WriteLog("empreinte de l'archive verifiee");

        SetStatus(owner, T("Extraction des fichiers du jeu...", "Extracting the game files...", "Extrayendo los archivos del juego...", "Распаковка файлов игры...", "Spieldateien werden entpackt...", "جارٍ استخراج ملفات اللعبة...", "正在解压游戏文件...", "Estrazione dei file del gioco...", "Se extrag fișierele jocului...", "A játékfájlok kibontása..."));
        UnzipGameArchive(zip, root);
        try { File.Delete(zip); } catch { }

        string game = Path.Combine(root, GameArchiveRoot);
        if (!IsGameFolder(game))
        {
            // Une archive peut nommer son dossier racine autrement : on cherche alors
            // le premier dossier qui ressemble vraiment a une installation.
            try
            {
                string[] dirs = Directory.GetDirectories(root);
                for (int i = 0; i < dirs.Length; i++)
                {
                    if (IsGameFolder(dirs[i])) { game = dirs[i]; break; }
                }
            }
            catch { }
        }
        if (!IsGameFolder(game))
        {
            Status = T("Fichiers du jeu extraits mais incomplets.", "Game files extracted but incomplete.", "Archivos del juego extraídos pero incompletos.", "Файлы игры распакованы, но неполны.", "Spieldateien entpackt, aber unvollständig.", "تم استخراج ملفات اللعبة لكنها غير مكتملة.", "游戏文件已解压但不完整。", "File del gioco estratti ma incompleti.", "Fișierele jocului au fost extrase, dar sunt incomplete.", "A játékfájlok kibontva, de hiányosak.");
            WriteLog(Status + " : " + root);
            return false;
        }

        ApplyGameDir(game);
        SaveConfig();
        WriteLog("jeu installe : " + game);
        return true;
    }

    // 8 Go ne passent pas par Expand-Archive sans etouffer : on utilise tar, livre avec
    // Windows 10 et 11, qui extrait le zip en flux. Expand-Archive reste en secours.
    private static void UnzipGameArchive(string zip, string target)
    {
        string tar = Path.Combine(Environment.SystemDirectory, "tar.exe");
        if (File.Exists(tar))
        {
            try
            {
                ProcessStartInfo info = new ProcessStartInfo(tar, "-xf \"" + zip + "\" -C \"" + target + "\"");
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                using (Process process = Process.Start(info))
                {
                    process.WaitForExit();
                    if (process.ExitCode == 0) return;
                    WriteLog("tar : code " + process.ExitCode + ", bascule sur Expand-Archive");
                }
            }
            catch (Exception error) { WriteLog("tar : " + error.Message); }
        }
        UnzipInto(zip, target);
    }

    private static void RunInstall(Form owner)
    {
        // Le jeu d'abord : sans ses fichiers, le pack n'a ou s'installer.
        if (!EnsureGameFiles(owner)) throw new Exception(Status);
        if (!IsGameFolder(GameDir)) throw new Exception("Rec Room introuvable dans " + GameDir);

        string pack = GetText(PackUrl);
        WriteLog("pack : " + PackUrl);
        BackupPackTargets();

        MatchCollection files = Regex.Matches(pack, "\"url\"\\s*:\\s*\"([^\"]+)\"\\s*,\\s*\"dest\"\\s*:\\s*\"([^\"]*)\"([^}]*)");
        if (files.Count == 0) throw new Exception("le manifeste du pack ne contient aucun fichier.");

        for (int i = 0; i < files.Count; i++)
        {
            string url = files[i].Groups[1].Value;
            string dest = files[i].Groups[2].Value;
            string meta = files[i].Groups[3].Value;
            bool archive = meta.IndexOf("\"archive\"", StringComparison.OrdinalIgnoreCase) >= 0;
            Match shaMatch = Regex.Match(meta, "\"sha256\"\\s*:\\s*\"([0-9a-fA-F]{64})\"");
            string sha = shaMatch.Success ? shaMatch.Groups[1].Value.ToLowerInvariant() : "";
            Match skipMatch = Regex.Match(meta, "\"skipIf\"\\s*:\\s*\"([^\"]+)\"");
            string skipIf = skipMatch.Success ? skipMatch.Groups[1].Value : "";
            if (!url.StartsWith("http", StringComparison.OrdinalIgnoreCase)) url = PackRoot + url.TrimStart('/');

            if (skipIf != "" && File.Exists(Path.Combine(GameDir, skipIf.Replace('/', '\\'))))
            {
                WriteLog("deja present : " + skipIf);
                continue;
            }

            string name = Path.GetFileName(new Uri(url).AbsolutePath);
            string target = (archive || dest == "")
                ? Path.Combine(Path.GetTempPath(), "recblue-" + name)
                : Path.Combine(GameDir, dest.Replace('/', '\\'));

            Directory.CreateDirectory(Path.GetDirectoryName(target));
            Fetch(owner, url, target, name);
            if (sha != "" && Sha256Of(target) != sha)
            {
                File.Delete(target);
                throw new Exception("empreinte differente pour " + name + ".");
            }
            if (archive)
            {
                SetStatus(owner, T("Extraction de ", "Extracting ", "Extrayendo ", "Распаковка ", "Entpacke ", "جارٍ استخراج ", "正在解压 ", "Estrazione di ", "Se extrage ", "Kibontás: ") + name + "...");
                UnzipInto(target, GameDir);
                File.Delete(target);
            }
            WriteLog("installe : " + url);
        }

        // Un manifeste plus ancien peut ne pas encore connaitre le chargeur : sans lui,
        // le plugin ne se charge pas. On installe alors le BepInEx officiel be.791.
        string corePath = Path.Combine(GameDir, @"BepInEx\core\BepInEx.Core.dll");
        string winhttpPath = Path.Combine(GameDir, "winhttp.dll");
        if (!Selected.Injector && (!File.Exists(corePath) || !File.Exists(winhttpPath)))
        {
            string loaderTarget = Path.Combine(Path.GetTempPath(), "recblue-bepinex-loader.zip");
            Fetch(owner, BepInExLoaderUrl, loaderTarget, "BepInEx");
            if (Sha256Of(loaderTarget) != BepInExLoaderSha)
            {
                File.Delete(loaderTarget);
                throw new Exception("empreinte differente pour le chargeur BepInEx.");
            }
            UnzipInto(loaderTarget, GameDir);
            File.Delete(loaderTarget);
            WriteLog("chargeur BepInEx installe");
        }

        // Le manifeste fournit la configuration du plugin a la racine du pack ; BepInEx la
        // lit dans config/. On la place la si elle n existe pas encore.
        if (!Selected.Injector)
        {
            string rootConfig = Path.Combine(GameDir, @"BepInEx\net.rec.plugin.cfg");
            string configDir = Path.Combine(GameDir, @"BepInEx\config");
            string config = Path.Combine(configDir, "net.rec.plugin.cfg");
            if (!File.Exists(config) && File.Exists(rootConfig))
            {
                Directory.CreateDirectory(configDir);
                File.Copy(rootConfig, config, false);
                WriteLog("configuration du plugin copiee dans BepInEx/config");
            }
        }
        else
        {
            EnsureInjectorConfig();
        }
        EnsureServerHost();

        List<string> problems = ProblemsFor(GameDir, Selected.PackFiles);
        if (problems.Count > 0) throw new Exception("pack incomplet : " + problems[0]);

        Status = T("Installation terminee - clique sur JOUER.", "Installation complete - click PLAY.", "Instalación completada: pulsa JUGAR.", "Установка завершена — нажмите ИГРАТЬ.", "Installation abgeschlossen – klicke auf SPIELEN.", "اكتمل التثبيت - اضغط العب.", "安装完成，请点击开始游戏。", "Installazione completata: premi GIOCA.", "Instalare finalizată - apasă JOACĂ.", "Telepítés kész – kattints a JÁTÉK-ra.");
        WriteLog(Status);
        Refresh(owner);
    }

    // Renseigne ApiHost dans 2025patch.ini uniquement s'il est vide : une valeur
    // deja choisie par le joueur n'est jamais ecrasee.
    private static void EnsureInjectorConfig()
    {
        string path = Path.Combine(GameDir, "2025patch.ini");
        if (!File.Exists(path)) return;
        string text = SafeRead(path);
        Match match = Regex.Match(text, @"(?m)^[ \t]*ApiHost[ \t]*=[ \t]*([^\r\n]*)");
        if (!match.Success || match.Groups[1].Value.Trim() != "") return;
        Group value = match.Groups[1];
        text = text.Substring(0, value.Index) + Selected.ServerHost + text.Substring(value.Index + value.Length);
        try
        {
            File.WriteAllText(path, text, new UTF8Encoding(false));
            WriteLog("2025patch.ini : ApiHost=" + Selected.ServerHost);
        }
        catch (Exception error) { WriteLog("2025patch.ini : " + error.Message); }
    }

    // Le pack a longtemps livré l'adresse workers.dev. On la remplace par le domaine
    // principal REC BLUE, sans toucher à un serveur personnalisé choisi par le joueur.
    private static void EnsureServerHost()
    {
        string path = Path.Combine(GameDir, Selected.ConfigRelative);
        if (!File.Exists(path)) return;
        string text = SafeRead(path);
        if (text.IndexOf("ns.recblue.workers.dev", StringComparison.OrdinalIgnoreCase) < 0) return;
        text = Regex.Replace(text, @"ns\.recblue\.workers\.dev", Selected.ServerHost, RegexOptions.IgnoreCase);
        try
        {
            File.WriteAllText(path, text, new UTF8Encoding(false));
            WriteLog("serveur : " + Selected.ServerHost);
        }
        catch (Exception error) { WriteLog("serveur : " + error.Message); }
    }

    // Avant d ecrire le pack, on garde une copie des seuls fichiers qu il remplace.
    // Le jeu lui-meme n est jamais touche ; les interop (volumineux) sont regeneres.
    private static void BackupPackTargets()
    {
        try
        {
            if (Selected.Injector)
            {
                Directory.CreateDirectory(Backup);
                for (int i = 0; i < Selected.PackFiles.Length; i++)
                {
                    string relative = Selected.PackFiles[i].Path;
                    string source = Path.Combine(GameDir, relative);
                    string target = Path.Combine(Backup, relative);
                    if (!File.Exists(source) || File.Exists(target)) continue;
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    File.Copy(source, target, false);
                }
                return;
            }
            Directory.CreateDirectory(Backup);
            BackupPackFile("winhttp.dll", "winhttp.dll");
            BackupPackFile("doorstop_config.ini", "doorstop_config.ini");
            BackupPackFile(@"BepInEx\plugins\RecNetPlugin.dll", @"plugins\RecNetPlugin.dll");
            BackupPackFile(@"BepInEx\config\net.rec.plugin.cfg", @"config\net.rec.plugin.cfg");

            string core = Path.Combine(GameDir, @"BepInEx\core");
            string coreBackup = Path.Combine(Backup, "core");
            if (Directory.Exists(core) && !Directory.Exists(coreBackup))
            {
                Directory.CreateDirectory(coreBackup);
                CopyTree(core, coreBackup);
            }
        }
        catch (Exception error) { WriteLog("sauvegarde : " + error.Message); }
    }

    private static void BackupPackFile(string relative, string backupRelative)
    {
        string source = Path.Combine(GameDir, relative);
        string target = Path.Combine(Backup, backupRelative);
        if (!File.Exists(source) || File.Exists(target)) return;
        Directory.CreateDirectory(Path.GetDirectoryName(target));
        File.Copy(source, target, false);
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch { }
    }

    // Telechargement reprenable : une archive de 4,3 Go ne doit pas repartir de zero
    // apres une coupure. Le corps va dans "<cible>.part", et un temoin voisin retient
    // l'URL et le validateur du serveur (ETag ou Last-Modified). Sans validateur, la
    // reprise n'est pas tentee : mieux vaut recommencer que coller deux corps differents.
    private static void Fetch(Form owner, string url, string target, string label)
    {
        string part = target + ".part";
        string witness = target + ".part.txt";
        long done = ResumeLength(url, part, witness);
        if (done > 0)
        {
            WriteLog("reprise du telechargement a " + (done / (1024 * 1024)) + " Mo : " + Path.GetFileName(target));
            SetStatus(owner, label + " - reprise...");
        }

        try
        {
            DownloadTo(owner, url, part, witness, label, done);
        }
        catch (WebException error)
        {
            // 416 : le reliquat est plus long que la ressource en ligne, il est faux.
            HttpWebResponse refused = error.Response as HttpWebResponse;
            if (refused == null || (int)refused.StatusCode != 416) throw;
            TryDelete(part);
            TryDelete(witness);
            WriteLog("reprise refusee par le serveur : nouveau telechargement");
            DownloadTo(owner, url, part, witness, label, 0);
        }

        // Le corps complet remplace la cible en une seule operation : un fichier
        // tronque ne peut jamais passer pour un telechargement termine.
        TryDelete(target);
        File.Move(part, target);
        TryDelete(witness);
    }

    // Les parties de l'archive sont telechargees une a une (chacune reprenable), ajoutees
    // a la suite d'un seul fichier, puis effacees : le disque ne porte jamais deux archives.
    // Une partie deja recollée fait un multiple exact de sa taille, ce qui suffit a savoir
    // ou reprendre, sans tenir de liste d'etat.
    private static void FetchParts(Form owner, string baseUrl, string target, string label)
    {
        string body = target + ".part";
        string next = target + ".next";

        long have = File.Exists(body) ? new FileInfo(body).Length : 0;
        int merged = (int)(have / GameArchivePartBytes);
        if (merged > GameArchiveParts) merged = GameArchiveParts;
        long aligned = (long)merged * GameArchivePartBytes;
        if (have != aligned)
        {
            // Recollage interrompu en plein milieu : on revient a une frontiere connue.
            try
            {
                using (FileStream trim = new FileStream(body, FileMode.Open, FileAccess.Write)) trim.SetLength(aligned);
            }
            catch
            {
                merged = 0;
                TryDelete(body);
            }
        }
        if (merged > 0) WriteLog("reprise de l'archive : " + merged + " partie(s) en place");

        for (int index = merged + 1; index <= GameArchiveParts; index++)
        {
            string url = baseUrl + ".part" + index.ToString("00");
            SetStatus(owner, label + "  " + index + "/" + GameArchiveParts + "...");
            WriteLog("partie " + index + "/" + GameArchiveParts + " : " + url);
            Fetch(owner, url, next, label + " " + index + "/" + GameArchiveParts);
            using (FileStream output = new FileStream(body, FileMode.Append, FileAccess.Write))
            using (FileStream input = new FileStream(next, FileMode.Open, FileAccess.Read))
            {
                byte[] buffer = new byte[131072];
                int read;
                while ((read = input.Read(buffer, 0, buffer.Length)) > 0) output.Write(buffer, 0, read);
            }
            TryDelete(next);
        }

        TryDelete(target);
        File.Move(body, target);
        WriteLog("archive assemblee : " + target);
    }

    // Octets deja recus, uniquement si le temoin designe la meme URL et porte un
    // validateur : c'est lui qui garantit que le corps n'a pas change entre-temps.
    private static long ResumeLength(string url, string part, string witness)
    {
        if (!File.Exists(part) || !File.Exists(witness)) return 0;
        string[] lines = SafeRead(witness).Replace("\r", "").Split('\n');
        if (lines.Length < 2) return 0;
        if (lines[0].Trim() != url) return 0;
        if (lines[1].Trim() == "") return 0;
        try { return new FileInfo(part).Length; }
        catch { return 0; }
    }

    private static void DownloadTo(Form owner, string url, string part, string witness, string label, long done)
    {
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
        request.UserAgent = "REC-BLUE-Launcher";
        request.Timeout = 120000;
        if (done > 0)
        {
            string[] lines = SafeRead(witness).Replace("\r", "").Split('\n');
            string validator = lines.Length >= 2 ? lines[1].Trim() : "";
            request.AddRange(done);
            if (validator != "") request.Headers["If-Range"] = validator;
        }

        using (WebResponse response = request.GetResponse())
        {
            HttpWebResponse http = response as HttpWebResponse;
            // 200 sur une demande avec Range : le serveur ignore la reprise, ou la
            // ressource a change. On ecrase le reliquat au lieu de l'allonger.
            bool appending = done > 0 && http != null && http.StatusCode == HttpStatusCode.PartialContent;
            if (!appending) done = 0;

            long total = response.ContentLength > 0 ? response.ContentLength + done : 0;
            string etag = (response.Headers["ETag"] ?? "").Trim();
            string lastModified = (response.Headers["Last-Modified"] ?? "").Trim();
            string validator = etag != "" ? etag : lastModified;
            try { File.WriteAllText(witness, url + "\n" + validator + "\n", new UTF8Encoding(false)); }
            catch { }

            long received = done;
            using (FileStream output = new FileStream(part, done > 0 ? FileMode.Append : FileMode.Create, FileAccess.Write))
            using (Stream input = response.GetResponseStream())
            {
                byte[] buffer = new byte[131072];
                int read;
                while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    output.Write(buffer, 0, read);
                    received += read;
                    if (total > 0) SetStatus(owner, label + "  -  " + (received * 100 / total) + " %");
                }
            }

            // Une coupure peut se terminer par une fin de flux propre : sans ce compte,
            // un fichier tronque passerait pour complet et l'empreinte le condamnerait a
            // etre retelecharge en entier. Ici le partiel reste et la reprise s'en sert.
            if (total > 0 && received != total)
            {
                throw new IOException("telechargement incomplet : " + received + " octets sur " + total);
            }
        }
    }

    private static string Sha256Of(string path)
    {
        using (FileStream stream = File.OpenRead(path))
        using (System.Security.Cryptography.SHA256 sha = System.Security.Cryptography.SHA256.Create())
        {
            byte[] hash = sha.ComputeHash(stream);
            return BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
        }
    }

    private static void SetStatus(Form owner, string text)
    {
        Status = text;
        Refresh(owner);
    }

    private static void Refresh(Form owner)
    {
        try { owner.BeginInvoke((MethodInvoker)delegate { owner.Invalidate(true); }); }
        catch { }
    }

    private static string GetText(string url)
    {
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
        request.UserAgent = "REC-BLUE-Launcher";
        request.Timeout = 20000;
        using (WebResponse response = request.GetResponse())
        using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
        {
            return reader.ReadToEnd();
        }
    }

    // ---- point d entree ------------------------------------------------------
    [STAThread]
    private static int Main(string[] args)
    {
        // .NET Framework negocie TLS 1.0 par defaut, que Supabase refuse : sans ces deux
        // lignes la connexion echouait sans jamais quitter la machine.
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | SecurityProtocolType.Tls11 | SecurityProtocolType.Tls;
        ServicePointManager.Expect100Continue = false;

        string shot = "";                double shotAt = 3.5;
        int bench = 0;
        bool check = false;
        bool vrCheck = false;
        bool authCheck = false;
        bool detect = false;
        bool install = false;
        bool fpsCheck = false;
        bool noIntro = false;
        int fpsSeconds = 7;
        int fpsArg = 0;
        bool explicitGameDir = false;
        string requestedGameDir = "";
        string profileArg = "";
        string packUrlArg = "";
        for (int i = 0; i < args.Length; i++)
        {
            string arg = args[i];
            if (arg.Equals("-NoAuto", StringComparison.OrdinalIgnoreCase)) NoAuto = true;
            else if (arg.Equals("-Check", StringComparison.OrdinalIgnoreCase)) check = true;
            else if (arg.Equals("-VrCheck", StringComparison.OrdinalIgnoreCase)) vrCheck = true;
            else if (arg.Equals("-AuthCheck", StringComparison.OrdinalIgnoreCase)) authCheck = true;
            else if (arg.Equals("-Shot", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length) shot = args[++i];
            else if (arg.Equals("-At", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
            {
                double parsed;
                if (double.TryParse(args[++i], NumberStyles.Float, CultureInfo.InvariantCulture, out parsed)) shotAt = parsed;
            }
            else if (arg.Equals("-Bench", StringComparison.OrdinalIgnoreCase))
            {
                bench = 300;
                if (i + 1 < args.Length)
                {
                    int frames;
                    if (int.TryParse(args[i + 1], out frames)) { bench = frames; i++; }
                }
            }
            else if (arg.Equals("-NoIntro", StringComparison.OrdinalIgnoreCase)) noIntro = true;
            else if (arg.Equals("-FpsCheck", StringComparison.OrdinalIgnoreCase))
            {
                fpsCheck = true;
                if (i + 1 < args.Length)
                {
                    int seconds;
                    if (int.TryParse(args[i + 1], out seconds) && seconds >= 2 && seconds <= 30)
                    {
                        fpsSeconds = seconds;
                        i++;
                    }
                }
            }
            else if (arg.Equals("-Fps", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
            {
                int fps;
                if (int.TryParse(args[++i], out fps) && IsSupportedFps(fps)) fpsArg = fps;
            }
            else if (arg.Equals("-Lang", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
            {
                string code = args[++i].Trim().ToLowerInvariant();
                if (IsKnownLang(code)) Lang = code;
            }
            else if (arg.Equals("-Detect", StringComparison.OrdinalIgnoreCase)) detect = true;
            else if (arg.Equals("-Install", StringComparison.OrdinalIgnoreCase)) install = true;
            else if (arg.Equals("-PackUrl", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length) packUrlArg = args[++i];
            else if (arg.Equals("-Profile", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length) profileArg = args[++i];
            else if (arg.Equals("-GameDir", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
            {
                requestedGameDir = args[++i];
                explicitGameDir = true;
            }
        }

        // Une mesure de frequence ne doit jamais lancer le jeu automatiquement.
        if (fpsCheck) NoAuto = true;

        // Le profil choisi fixe l'executable, le pack, la configuration et le nom du
        // processus. Sans -Profile, on reste exactement sur le comportement 2023, sauf
        // pour un binaire explicitement nomme 2025 : il porte alors son propre profil.
        if (profileArg == "" &&
            Path.GetFileNameWithoutExtension(Application.ExecutablePath).IndexOf("2025", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            profileArg = "2025";
        }
        if (profileArg == "2025") Selected = Profile2025;
        else if (profileArg != "" && profileArg != "2023")
        {
            Console.WriteLine("Profil inconnu : " + profileArg + " (attendu : 2023 ou 2025)");
            return 2;
        }
        PackUrl = packUrlArg != "" ? packUrlArg : Selected.PackUrl;

        // Le launcher peut vivre n importe ou : il retient le dossier du jeu dans sa
        // configuration, et detecte une installation Steam si aucun dossier n est connu.
        ApplyGameDir(Path.GetDirectoryName(Application.ExecutablePath));
        LoadConfig();
        if (fpsArg > 0) { FpsLimit = fpsArg; FpsManual = true; }
        if (explicitGameDir) ApplyGameDir(requestedGameDir);
        if (!explicitGameDir && !IsGameFolder(GameDir) &&
            Selected.DefaultGameDir != "" && Directory.Exists(Selected.DefaultGameDir))
        {
            ApplyGameDir(Selected.DefaultGameDir);
        }

        string detected = IsGameFolder(GameDir) ? GameDir : FindGameInstall();
        if (detected != "" && !explicitGameDir)
        {
            ApplyGameDir(detected);
            SaveConfig();
            WriteLog("jeu detecte : " + detected);
        }
        // Un launcher telecharge dans un autre dossier ne doit pas oublier le dossier
        // REC BLUE deja installe : sans cela il lance le Rec Room Steam, qui plante.
        if (!explicitGameDir)
        {
            string packed = FindPackedInstall();
            if (packed != "" && InstallScore(packed) > InstallScore(GameDir))
            {
                ApplyGameDir(packed);
                SaveConfig();
                WriteLog("dossier REC BLUE retrouve : " + packed);
            }
        }
        LoadLogoFont();
        LoadLogoImage();
        ResetStatus();
        UpdateAccountLabel();

        if (check || vrCheck || shot != "" || bench > 0 || authCheck || detect || install || fpsCheck) AttachConsole(-1);

        if (detect)
        {
            Console.WriteLine("--- REC BLUE : detection ---");
            Console.WriteLine("Dossier courant : " + GameDir + (IsGameFolder(GameDir) ? " (valide)" : " (non valide)"));
            List<string> installs = FindGameInstalls();
            if (installs.Count == 0) Console.WriteLine("Aucune installation Rec Room valide detectee.");
            else foreach (string item in installs) Console.WriteLine("Trouve : " + item);
            return 0;
        }

        if (install)
        {
            if (!IsGameFolder(GameDir))
            {
                Console.WriteLine("Rec Room introuvable dans " + GameDir);
                return 2;
            }
            try
            {
                RunInstall(null);
                Console.WriteLine(Status);
                return 0;
            }
            catch (Exception error)
            {
                Console.WriteLine("ERREUR " + error.Message);
                return 1;
            }
        }

        if (authCheck)
        {
            // Test du chemin reseau complet (TLS + en-tetes + service) avec un compte qui
            // n existe pas : un refus propre prouve que la machine joint bien le service.
            string outcome = ConnectAccount("test-inexistant@players.recblue.invalid", "motdepassebidon123");
            string line = "auth : " + (outcome == "" ? "ACCEPTE (inattendu)" : outcome);
            Console.WriteLine(line);
            WriteLog(line);
            return 0;
        }

        if (check)
        {
            List<string> problems = GetProblems();
            WriteLog("--- verification des fichiers ---");
            if (problems.Count == 0) WriteLog("OK : tous les fichiers sont presents et valides.");
            else foreach (string problem in problems) WriteLog(problem);
            WriteLog("Sauvegarde de reference presente : " + Directory.Exists(Backup));
            Console.WriteLine("--- REC BLUE : verification des fichiers ---");
            if (problems.Count == 0) Console.WriteLine("OK : tous les fichiers sont presents et valides.");
            else foreach (string problem in problems) Console.WriteLine(problem);
            Console.WriteLine("Sauvegarde de reference presente : " + Directory.Exists(Backup));
            return 0;
        }

        if (vrCheck)
        {
            string vrstart = FindSteamVr();
            WriteLog("--- VR ---");
            WriteLog(vrstart == "" ? "SteamVR : introuvable" : "SteamVR : " + vrstart);
            WriteLog(TestVrHeadset() ? "Casque : detecte" : "Casque : aucun");
            Console.WriteLine("--- REC BLUE : VR ---");
            Console.WriteLine(vrstart == "" ? "SteamVR : introuvable (le bouton JOUER EN VR le dira aussi)." : "SteamVR : " + vrstart);
            Console.WriteLine(TestVrHeadset() ? "Casque : detecte" : "Casque : aucun (le bouton JOUER EN VR refusera de lancer)");
            return 0;
        }

        Application.EnableVisualStyles();
        if (shot != "" || bench > 0 || noIntro) Intro = false;

        if (shot != "")
        {
            BgBmp = BuildBackground(W, H);
            LightFrames = BuildLightFrames(W / 2, H / 2);
            PatBmp = BuildPattern(W, H);
            LoadIntroTitle();
            LogoBmp = BuildLogo(W, H);
            using (Bitmap bitmap = new Bitmap(W, H))
            {
                Ox = PatternSpeed * shotAt;
                Oy = PatternSpeed * shotAt;
                using (Graphics g = Graphics.FromImage(bitmap))
                {
                    RenderFrame(g, W, H, Ox, Oy, shotAt, false, 45, T("Serveur : en ligne  -  Fichiers du jeu : OK", "Server: online  -  Game files: OK", "Servidor: en línea  -  Archivos del juego: OK", "Сервер: онлайн  -  Файлы игры: в порядке", "Server: online  -  Spieldateien: OK", "الخادم: متصل  -  ملفات اللعبة: سليمة", "服务器：在线  -  游戏文件：正常", "Server: online  -  File di gioco: OK", "Server: online  -  Fișierele jocului: OK", "Szerver: online  -  Játékfájlok: rendben"), 1);
                }
                bitmap.Save(shot, ImageFormat.Png);
            }
            Console.WriteLine("image ecrite : " + shot);
            return 0;
        }

        if (bench > 0)
        {
            BgBmp = BuildBackground(W, H);
            LightFrames = BuildLightFrames(W / 2, H / 2);
            PatBmp = BuildPattern(W, H);
            LoadIntroTitle();
            LogoBmp = BuildLogo(W, H);
            using (Bitmap bitmap = new Bitmap(W, H))
            {
                using (Graphics g = Graphics.FromImage(bitmap))
                {
                    for (int i = 0; i < 40; i++) RenderFrame(g, W, H, 0, 0, 0, false, 0, "chauffe", 1);

                    double total = Stage(g, bench, delegate(Graphics gfx)
                    {
                        RenderFrame(gfx, W, H, 3.25f, -4.5f, Anim, false, 0, T("Serveur : en ligne  -  Fichiers du jeu : OK", "Server: online  -  Game files: OK", "Servidor: en línea  -  Archivos del juego: OK", "Сервер: онлайн  -  Файлы игры: в порядке", "Server: online  -  Spieldateien: OK", "الخادم: متصل  -  ملفات اللعبة: سليمة", "服务器：在线  -  游戏文件：正常", "Server: online  -  File di gioco: OK", "Server: online  -  Fișierele jocului: OK", "Szerver: online  -  Játékfájlok: rendben"), 1);
                    });
                    double bg = Stage(g, bench, delegate(Graphics gfx) { gfx.DrawImageUnscaled(BgBmp, 0, 0); });
                    double pattern = Stage(g, bench, delegate(Graphics gfx)
                    {
                        gfx.PixelOffsetMode = PixelOffsetMode.Half;
                        gfx.InterpolationMode = InterpolationMode.NearestNeighbor;
                        gfx.DrawImage(PatBmp, new RectangleF(3.25f, -4.5f, PatBmp.Width, PatBmp.Height),
                            new RectangleF(0, 0, PatBmp.Width, PatBmp.Height), GraphicsUnit.Pixel);
                    });
                    double halos = Stage(g, bench, delegate(Graphics gfx) { DrawLightDrift(gfx, W, H, 3.5); });
                    double logo = Stage(g, bench, delegate(Graphics gfx) { gfx.DrawImageUnscaled(LogoBmp, 0, 0); });
                    double ui = Stage(g, bench, delegate(Graphics gfx)
                    {
                        if (UiBmp != null) gfx.DrawImageUnscaled(UiBmp, 0, 0);
                    });

                    string line = "rendu : " + total.ToString("0.00", CultureInfo.InvariantCulture) + " ms / image (" +
                                  (1000.0 / total).ToString("0", CultureInfo.InvariantCulture) + " img/s)  |  fond " +
                                  bg.ToString("0.00", CultureInfo.InvariantCulture) + "  motif " + pattern.ToString("0.00", CultureInfo.InvariantCulture) +
                                  "  halos " + halos.ToString("0.00", CultureInfo.InvariantCulture) + "  logo " + logo.ToString("0.00", CultureInfo.InvariantCulture) +
                                  "  boutons " + ui.ToString("0.00", CultureInfo.InvariantCulture);
                    Console.WriteLine(line);
                    WriteLog(line);
                }
            }
            return 0;
        }

        bool created;
        using (Mutex single = new Mutex(true, "RECBLUE_LAUNCHER_SINGLE_WINDOW", out created))
        {
            if (!created) return 0;

            // Mesure des images reellement peintes, sans auto-lancement du jeu.
            int fpsFrames = 0;
            int fpsLongFrames = 0;
            int fpsTicks = 0;
            double fpsStart = 0.0;
            double fpsLastPaint = 0.0;
            double fpsWorstGap = 0.0;
            double fpsPaintTotal = 0.0;
            double fpsMaxPaint = 0.0;
            bool fpsReported = false;

            BgBmp = LoadBackdrop(W, H);
            // Le fond fourni contient deja le motif : pas de motifs ni de halos
            // supplementaires par-dessus.
            LightFrames = null;
            PatBmp = null;
            LoadIntroTitle();
            BuildIntroTitleCache(W);
            LogoBmp = BuildLogo(W, H);
            BuildLogoPhases();

            Form form = new Form();
            form.Text = "REC BLUE";
            form.FormBorderStyle = FormBorderStyle.None;
            form.StartPosition = FormStartPosition.Manual;
            form.ClientSize = new Size(W, H);
            Rectangle workArea = Screen.FromPoint(Cursor.Position).WorkingArea;
            form.Location = new Point(
                workArea.Left + Math.Max(0, (workArea.Width - form.Width) / 2),
                workArea.Top + Math.Max(0, (workArea.Height - form.Height) / 2));

            // Bordures arrondies : la fenetre est decoupee au meme rayon que le dessin.
            using (GraphicsPath windowShape = RoundRect(0, 0, W, H, WindowRadius))
            {
                form.Region = new Region(windowShape);
            }
            form.BackColor = Color.FromArgb(22, 48, 116);
            form.ShowIcon = false;

            Canvas panel = new Canvas();
            panel.Dock = DockStyle.Fill;
            panel.BackColor = Color.FromArgb(22, 48, 116);
            panel.Paint += delegate(object sender, PaintEventArgs e)
            {
                long paintStart = Clock.ElapsedTicks;
                RenderFrame(e.Graphics, panel.Width, panel.Height, Ox, Oy, Anim, Loading, Spin, Status, Hover);
                if (fpsCheck)
                {
                    double paintMs = (Clock.ElapsedTicks - paintStart) * 1000.0 / Stopwatch.Frequency;
                    fpsPaintTotal += paintMs;
                    if (paintMs > fpsMaxPaint) fpsMaxPaint = paintMs;
                    double now = Clock.Elapsed.TotalSeconds;
                    if (fpsStart <= 0.0)
                    {
                        fpsStart = now;
                        fpsFrames = 1;
                    }
                    else
                    {
                        double gap = now - fpsLastPaint;
                        if (gap > fpsWorstGap) fpsWorstGap = gap;
                        if (gap > 0.020) fpsLongFrames++;
                        fpsFrames++;
                    }
                    fpsLastPaint = now;
                }
            };
            form.Controls.Add(panel);

            bool drag = false;
            Point dragStart = Point.Empty;

            panel.MouseMove += delegate(object sender, MouseEventArgs e)
            {
                if (Intro) { Hover = 0; panel.Cursor = Cursors.Default; return; }
                Point at = ToDesign(panel, e.X, e.Y);
                int mx = at.X;
                int my = at.Y;
                int before = Hover;
                if (InButton(0, mx, my)) Hover = 1;
                else if (InButton(1, mx, my)) Hover = 2;
                else if (InButton(2, mx, my)) Hover = 3;
                else if (InButton(3, mx, my)) Hover = 4;
                else if (InAccount(mx, my)) Hover = 5;
                else if (Current != null && InLogout(mx, my)) Hover = 6;
                else if (InStorage(mx, my)) Hover = 7;
                else if (InUninstall(mx, my)) Hover = 8;
                else if (InClose(mx, my)) Hover = 9;
                else if (InLang(mx, my)) Hover = 10;
                else if (InFps(mx, my)) Hover = 11;
                else Hover = 0;
                if (drag)
                {
                    form.Left += e.X - dragStart.X;
                    form.Top += e.Y - dragStart.Y;
                    KeepWindowOnScreen(form);
                }
                if (before != Hover) panel.Cursor = Hover != 0 ? Cursors.Hand : Cursors.Default;
            };
            panel.MouseDown += delegate(object sender, MouseEventArgs e) { drag = true; dragStart = new Point(e.X, e.Y); };
            panel.MouseUp += delegate(object sender, MouseEventArgs e)
            {
                drag = false;
                Point at = ToDesign(panel, e.X, e.Y);
                int mx = at.X;
                int my = at.Y;
                if (InClose(mx, my)) { form.Close(); return; }
                if (Intro) return;
                if (Loading) return;
                if (InFps(mx, my)) { CycleFps(form); panel.Invalidate(); return; }
                if (InButton(0, mx, my)) { StartGame(false); panel.Invalidate(); return; }
                if (InButton(1, mx, my)) { StartGame(true); panel.Invalidate(); return; }
                if (InButton(2, mx, my))
                {
                    Status = "Reparation en cours...";
                    panel.Refresh();
                    List<string> lines = RepairGame();
                    foreach (string line in lines) WriteLog(line);
                    Status = string.Join(" ", lines.ToArray()).IndexOf("TOUT EST OK") >= 0
                        ? "Reparation terminee : tout est OK."
                        : "Reparation terminee - voir REC-BLUE-Launcher.log";
                    panel.Invalidate();
                    return;
                }
                if (InButton(3, mx, my))
                {
                    if (!IsGameFolder(GameDir)) ShowInstaller(form);
                    else InstallPack(form, false);
                    panel.Invalidate();
                    return;
                }
                if (InAccount(mx, my))
                {
                    if (Current == null)
                    {
                        // Ouvrir la connexion suspend le compte a rebours : on ne lance pas le jeu
                        // par-dessus la fenetre de compte.
                        AutoAt = DateTime.MinValue;
                        using (LoginDialog dialog = new LoginDialog()) { dialog.ShowDialog(form); }
                        if (Current != null) Status = "Connecte : " + Current.Pseudo + "  -  le jeu reste joignable";
                        panel.Invalidate();
                    }
                    return;
                }
                if (Current != null && InLogout(mx, my))
                {
                    DisconnectAccount();
                    panel.Invalidate();
                    return;
                }
                if (InStorage(mx, my))
                {
                    ChooseStorage(form);
                    panel.Invalidate();
                    return;
                }
                if (InUninstall(mx, my))
                {
                    Uninstall(form);
                    panel.Invalidate();
                    return;
                }
                if (InLang(mx, my))
                {
                    LanguageDialog dialog = new LanguageDialog();
                    dialog.ShowDialog(form);
                    string picked = dialog.PickedCode;
                    dialog.Dispose();
                    if (picked != null && picked != Lang)
                    {
                        Lang = picked;
                        SaveConfig();
                        ApplyLanguage();
                    }
                    panel.Invalidate();
                }
            };
            form.KeyPreview = true;
            form.KeyDown += delegate(object sender, KeyEventArgs e) { if (e.KeyCode == Keys.Escape) form.Close(); };

            Thread frameThread = null;
            form.FormClosed += delegate { FrameClockRunning = false; };
            form.Shown += delegate
            {
                KeepWindowOnScreen(form);
                Rectangle shownArea = Screen.FromControl(form).WorkingArea;
                WriteLog("fenetre : " + form.Left + "," + form.Top + " " + form.Width + "x" + form.Height +
                         " - zone " + shownArea.Left + "," + shownArea.Top + " " + shownArea.Width + "x" + shownArea.Height);
                if (!FpsManual) ApplyAutoFps(form);
                else WriteLog("cadence : " + FpsLimit + " i/s (reglage)");
                IntroAt = DateTime.Now;
                IntroStartAnim = Clock.Elapsed.TotalSeconds;
                LastTick = Clock.Elapsed.TotalSeconds;
                FramePosted = 0;
                FrameClockRunning = true;
                frameThread.Start();
                LoadAccount();
                CheckServerAsync(panel);
                WatchServerAsync(panel);
                if (!IsGameFolder(GameDir))
                {
                    form.BeginInvoke((MethodInvoker)delegate { ShowInstaller(form); });
                }
            };

            // Horloge haute resolution : un thread dedie vise la cadence choisie
            // (60, 120 ou 240 i/s) et poste le tick sur le thread UI. Le timer
            // WinForms ne peut pas tenir cette cadence sur cette machine.
            Action frameTick = delegate
            {
                Interlocked.Exchange(ref FramePosted, 0);
                if (!FrameClockRunning) return;

                double now = Clock.Elapsed.TotalSeconds;
                double dt = now - LastTick;
                if (dt <= 0 || dt > 0.5) dt = 0.016;
                LastTick = now;
                Anim = now;
                if (fpsCheck && fpsStart > 0.0) fpsTicks++;

                if (fpsCheck && !fpsReported && fpsStart > 0.0 && now - fpsStart >= fpsSeconds)
                {
                    fpsReported = true;
                    double span = now - fpsStart;
                    double fps = span > 0.0 ? fpsFrames / span : 0.0;
                    string line = "fps : " + fps.ToString("0.0", CultureInfo.InvariantCulture) + " i/s (" +
                                  fpsFrames + " images en " + span.ToString("0.00", CultureInfo.InvariantCulture) +
                                  " s, cible " + FpsLimit + " i/s, intervalle max " + (fpsWorstGap * 1000.0).ToString("0.0", CultureInfo.InvariantCulture) +
                                  " ms, " + fpsLongFrames + " images > 20 ms, ticks " + fpsTicks +
                                  ", peinture " + (fpsFrames > 0 ? fpsPaintTotal / fpsFrames : 0.0).ToString("0.0", CultureInfo.InvariantCulture) +
                                  " ms max " + fpsMaxPaint.ToString("0.0", CultureInfo.InvariantCulture) + " ms)";
                    Console.WriteLine(line);
                    WriteLog(line);
                    form.Close();
                    return;
                }

                if (Intro)
                {
                    double introElapsed = (DateTime.Now - IntroAt).TotalSeconds;
                    // Intro courte : barre pleine en 1,00 s, puis fondu de 0,45 s
                    // (menu complet vers 1,50 s).
                    IntroProgress = Math.Min(1.0, introElapsed / 1.00);
                    if (introElapsed > 1.05)
                    {
                        // On fige la derniere image de l intro une seule fois, puis on
                        // la fait disparaitre par-dessus le menu rendu normalement.
                        if (IntroFadeBmp == null)
                        {
                            IntroFadeBmp = new Bitmap(W, H);
                            MenuReveal = 0.0;
                            using (Graphics fadeGraphics = Graphics.FromImage(IntroFadeBmp))
                            {
                                RenderIntro(fadeGraphics, W, H);
                            }
                        }
                        IntroFade = Math.Min(1.0, IntroFade + dt / IntroFadeSeconds);
                        if (IntroFade >= 1.0)
                        {
                            Intro = false;
                            UiBmp = null;
                            IntroFade = 0.0;
                            MenuReveal = 0.0;
                            if (IntroFadeBmp != null)
                            {
                                IntroFadeBmp.Dispose();
                                IntroFadeBmp = null;
                            }
                        }
                    }
                }

                if (!Intro && MenuReveal < 1.0)
                {
                    MenuReveal = Math.Min(1.0, MenuReveal + dt / MenuRevealSeconds);
                }

                // Motif : glissement diagonal a PatternSpeed, en secondes reelles.
                Ox += PatternSpeed * dt;
                Oy += PatternSpeed * dt;
                if (Loading) Spin += 520 * dt;

                if (Loading)
                {
                    Poll++;
                    if (Poll >= 50) { Poll = 0; PollLoading(); }
                }
                else if (ServerChecked && !NoAuto && AutoAt == DateTime.MinValue && !AutoDone)
                {
                    List<string> problems = GetProblems();
                    if (ServerOk && problems.Count == 0)
                    {
                        AutoVr = TestVrHeadset();
                        AutoAt = DateTime.Now.AddSeconds(5);
                        WriteLog("lancement automatique " + (AutoVr ? "en VR" : "a l ecran") + " dans 5 s");
                    }
                }

                if (AutoAt != DateTime.MinValue && !AutoDone && !Loading)
                {
                    double left = (AutoAt - DateTime.Now).TotalSeconds;
                    if (left > 0)
                    {
                        Status = "Lancement " + (AutoVr ? "en VR" : "a l ecran") + " dans " +
                                 ((int)Math.Ceiling(left)) + " s  -  clique pour changer de mode";
                    }
                    else
                    {
                        AutoDone = true;
                        AutoAt = DateTime.MinValue;
                        StartGame(AutoVr);
                    }
                }
                panel.Invalidate();
            };

            // Une seule frame en attente a la fois : si le thread UI est occupe,
            // on saute la frame au lieu d accumuler du retard.
            Action scheduleFrame = delegate
            {
                if (!FrameClockRunning) return;
                if (Interlocked.CompareExchange(ref FramePosted, 1, 0) != 0) return;
                try
                {
                    form.BeginInvoke(frameTick);
                }
                catch (InvalidOperationException)
                {
                    Interlocked.Exchange(ref FramePosted, 0);
                }
            };

            frameThread = new Thread(delegate()
            {
                int lastFps = FpsLimit;
                double frameSeconds = 1.0 / Math.Max(1, lastFps);
                double next = Clock.Elapsed.TotalSeconds + frameSeconds;
                while (FrameClockRunning)
                {
                    if (lastFps != FpsLimit)
                    {
                        lastFps = FpsLimit;
                        frameSeconds = 1.0 / Math.Max(1, lastFps);
                        next = Math.Min(next, Clock.Elapsed.TotalSeconds + frameSeconds);
                    }
                    double wait = next - Clock.Elapsed.TotalSeconds;
                    if (wait > 0.0015)
                    {
                        int sleep = (int)((wait - 0.001) * 1000.0);
                        if (sleep > 0) Thread.Sleep(sleep);
                    }
                    while (FrameClockRunning && Clock.Elapsed.TotalSeconds < next) Thread.SpinWait(60);
                    if (!FrameClockRunning) break;
                    scheduleFrame();
                    next += frameSeconds;
                    if (Clock.Elapsed.TotalSeconds - next > frameSeconds)
                    {
                        next = Clock.Elapsed.TotalSeconds + frameSeconds;
                    }
                }
            });
            frameThread.IsBackground = true;
            frameThread.Name = "REC BLUE refresh";

            // Pack absent ou incomplet : le launcher l installe seul au demarrage, sans
            // question. Le joueur n a plus qu a cliquer sur JOUER.
            if (!detect && !install && !check && !vrCheck && !authCheck && !fpsCheck && shot == "" && bench <= 0 &&
                IsGameFolder(GameDir) && GetProblems().Count > 0)
            {
                InstallPack(null, true);
            }
            // La resolution 1 ms est necessaire au Sleep/Spin de l horloge.
            timeBeginPeriod(1);
            Application.Run(form);
            FrameClockRunning = false;
            if (frameThread != null && frameThread.IsAlive) frameThread.Join(100);
            timeEndPeriod(1);
        }
        return 0;
    }

    // ---- dossier du jeu, desinstallation -------------------------------------
    internal static string ConfigFile
    {
        get
        {
            string name = Selected.Id == "2023" ? "REC-BLUE-Config.json" : "REC-BLUE-Config-" + Selected.Id + ".json";
            // Le launcher peut etre telecharge n importe ou : la configuration vit dans le
            // profil Windows. Sinon un exe fraichement telecharge oublie le dossier du jeu
            // et repart sur l installation Steam, qui refuse le pack (plantage Referee.dll).
            string folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "REC-BLUE");
            try { Directory.CreateDirectory(folder); }
            catch { }
            string stable = Path.Combine(folder, name);
            if (!File.Exists(stable))
            {
                string legacy = Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), name);
                if (File.Exists(legacy))
                {
                    try { File.Copy(legacy, stable, false); }
                    catch { }
                }
            }
            return stable;
        }
    }

    // Le dossier contient-il deja l installation REC BLUE (pack + chargeur) ?
    private static bool HasPack(string dir)
    {
        if (dir == "" || !Directory.Exists(dir)) return false;
        return File.Exists(Path.Combine(dir, @"BepInEx\plugins\RecNetPlugin.dll"))
            || File.Exists(Path.Combine(dir, @"BepInEx\core\BepInEx.Core.dll"));
    }

    // Combien ce dossier ressemble a une installation REC BLUE ? Le launcher installe,
    // son journal et le pack pesent plus qu un Rec Room Steam ou le pack a ete copie.
    private static int InstallScore(string dir)
    {
        if (dir == "" || !Directory.Exists(dir) || !IsGameFolder(dir)) return -1;
        int score = 1;
        if (HasPack(dir)) score += 2;
        if (File.Exists(Path.Combine(dir, "REC-BLUE-Launcher.log"))) score += 2;
        if (File.Exists(Path.Combine(dir, "REC-BLUE-Launcher.exe"))) score += 3;
        return score;
    }

    // Meilleur dossier REC BLUE connu, pour ne pas lancer un Rec Room Steam vierge.
    private static string FindPackedInstall()
    {
        List<string> candidates = new List<string>();
        if (Selected.DefaultGameDir != "") candidates.Add(Selected.DefaultGameDir);
        candidates.Add(GameDir);
        candidates.Add(@"C:\RecRoom2023");
        candidates.Add(@"C:\RecRoom2025");
        string best = "";
        int bestScore = 1;
        for (int i = 0; i < candidates.Count; i++)
        {
            int score = InstallScore(candidates[i]);
            if (score > bestScore) { bestScore = score; best = candidates[i]; }
        }
        return best;
    }

    private static void ApplyGameDir(string dir)
    {
        GameDir = dir;
        Exe = Path.Combine(dir, Selected.ExeName);
        Backup = Path.Combine(dir, "REC-BLUE-Backup");
        LogFile = Path.Combine(dir, "REC-BLUE-Launcher.log");
    }

    private static void LoadConfig()
    {
        if (!File.Exists(ConfigFile)) return;
        // Une config corrompue (chemin re-echappe des milliers de fois) ne doit
        // jamais etre chargee en memoire : on repart de la detection automatique.
        try
        {
            if (new FileInfo(ConfigFile).Length > 64 * 1024)
            {
                WriteLog("config trop grosse : ignoree");
                return;
            }
        }
        catch { return; }
        string raw = SafeRead(ConfigFile);
        string code = JsonString(raw, "lang");
        if (IsKnownLang(code)) Lang = code;
        string fps = JsonString(raw, "fps");
        int parsedFps;
        if (int.TryParse(fps, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsedFps) && IsSupportedFps(parsedFps))
        {
            FpsLimit = parsedFps;
            FpsManual = true;
        }
        string dir = JsonString(raw, "gameDir");
        // Anciennes configurations : le chemin a ete re-echappe plusieurs fois
        // (c:\\\\program files...). On le remet en forme avant de le tester.
        if (dir != "") dir = Regex.Replace(dir, @"\\{2,}", @"\");
        // Le profil 2025 peut pointer un dossier prepare mais pas encore complet :
        // on le retient des qu'il existe, pour que le bouton INSTALLER le cible.
        if (dir != "" && (IsGameFolder(dir) || (!Selected.ScanSteam && Directory.Exists(dir)))) ApplyGameDir(dir);
    }

    private static void SaveConfig()
    {
        try
        {
            string fps = FpsManual ? ",\"fps\":\"" + FpsLimit.ToString(CultureInfo.InvariantCulture) + "\"" : "";
            File.WriteAllText(ConfigFile,
                "{\"gameDir\":\"" + Escape(GameDir) + "\",\"lang\":\"" + Escape(Lang) + "\"" + fps + "}",
                new UTF8Encoding(false));
        }
        catch { }
    }

    // Le jeu peut vivre sur un autre disque : le dossier choisi est retenu et reverifie.
    private static void ChooseStorage(Form owner)
    {
        if (GameRunning())
        {
            Status = T("Rec Room tourne : ferme-le avant de changer de dossier.", "Rec Room is running: close it before changing folders.", "Rec Room está abierto: ciérralo antes de cambiar de carpeta.", "Rec Room запущен: закройте его перед сменой папки.", "Rec Room läuft: schließe es vor dem Ordnerwechsel.", "Rec Room يعمل: أغلقه قبل تغيير المجلد.", "Rec Room 正在运行：请关闭后再更换文件夹。", "Rec Room è in esecuzione: chiudilo prima di cambiare cartella.", "Rec Room rulează: închide-l înainte de a schimba folderul.", "A Rec Room fut: zárd be a mappaváltás előtt.");
            WriteLog(Status);
            return;
        }
        using (FolderBrowserDialog dialog = new FolderBrowserDialog())
        {
            dialog.Description = "Dossier de l'installation Rec Room (celui qui contient RecRoom.exe)";
            dialog.ShowNewFolderButton = false;
            try { if (Directory.Exists(GameDir)) dialog.SelectedPath = GameDir; }
            catch { }
            if (dialog.ShowDialog(owner) != DialogResult.OK) return;

            string chosen = dialog.SelectedPath;
            if (!IsGameFolder(chosen))
            {
                Status = T("Ce dossier ne contient pas une installation Rec Room valide.", "This folder does not contain a valid Rec Room installation.", "Esta carpeta no contiene una instalación válida de Rec Room.", "В этой папке нет действительной установки Rec Room.", "Dieser Ordner enthält keine gültige Rec Room-Installation.", "لا يحتوي هذا المجلد على تثبيت Rec Room صالح.", "此文件夹没有有效的 Rec Room 安装。", "Questa cartella non contiene un'installazione valida di Rec Room.", "Acest folder nu conține o instalare Rec Room validă.", "Ez a mappa nem tartalmaz érvényes Rec Room-telepítést.");
                WriteLog(Status + " : " + chosen);
                return;
            }
            ApplyGameDir(chosen);
            SaveConfig();

            List<string> problems = GetProblems();
            string dossier = T("Dossier du jeu : ", "Game folder: ", "Carpeta del juego: ", "Папка игры: ", "Spielordner: ", "مجلد اللعبة: ", "游戏文件夹：", "Cartella del gioco: ", "Folderul jocului: ", "Játékmappa: ");
            Status = problems.Count == 0
                ? dossier + chosen + "  -  " + T("fichiers OK", "Files OK", "archivos OK", "файлы в порядке", "Dateien OK", "الملفات سليمة", "文件正常", "file OK", "fișiere OK", "fájlok rendben")
                : dossier + chosen + "  -  " + problems[0];
            WriteLog("dossier du jeu : " + chosen);
            // Pas de lancement surprise juste apres un changement de dossier.
            AutoAt = DateTime.MinValue;
            AutoDone = true;
        }
    }

    // Desinstallation : on retire l installation REC BLUE, jamais les fichiers du jeu.
    private static void Uninstall(Form owner)
    {
        if (GameRunning())
        {
            Status = T("Rec Room tourne : ferme-le avant de desinstaller.", "Rec Room is running: close it before uninstalling.", "Rec Room está abierto: ciérralo antes de desinstalar.", "Rec Room запущен: закройте его перед удалением.", "Rec Room läuft: schließe es vor der Deinstallation.", "Rec Room يعمل: أغلقه قبل إلغاء التثبيت.", "Rec Room 正在运行：请关闭后再卸载。", "Rec Room è in esecuzione: chiudilo prima di disinstallare.", "Rec Room rulează: închide-l înainte de dezinstalare.", "A Rec Room fut: zárd be az eltávolítás előtt.");
            WriteLog(Status);
            return;
        }
        string message = T("Supprimer l installation REC BLUE de :", "Remove the REC BLUE installation from:", "Eliminar la instalación REC BLUE de:", "Удалить установку REC BLUE из:", "REC BLUE-Installation entfernen aus:", "إزالة تثبيت REC BLUE من:", "移除 REC BLUE 安装文件夹：", "Rimuovere l'installazione REC BLUE da:", "Elimină instalarea REC BLUE din:", "REC BLUE telepítés eltávolítása innen:") + "\n" + GameDir + "\n\n" +
            T("Seront supprimes :", "The following will be deleted:", "Se eliminarán:", "Будет удалено:", "Gelöscht wird:", "سيُحذف:", "将删除：", "Verranno eliminati:", "Se vor șterge:", "Törlődik:") + "\n" +
            T("- le dossier BepInEx (plugin et configuration du serveur)", "- the BepInEx folder (plugin and server configuration)", "- la carpeta BepInEx (plugin y configuración del servidor)", "- папка BepInEx (плагин и настройки сервера)", "- der BepInEx-Ordner (Plugin und Serverkonfiguration)", "- مجلد BepInEx (الإضافة وإعدادات الخادم)", "- BepInEx 文件夹（插件与服务器配置）", "- la cartella BepInEx (plugin e configurazione del server)", "- folderul BepInEx (plugin și configurare server)", "- a BepInEx mappa (plugin és szerverbeállítás)") + "\n" +
            T("- winhttp.dll et doorstop_config.ini (le chargeur)", "- winhttp.dll and doorstop_config.ini (the loader)", "- winhttp.dll y doorstop_config.ini (el cargador)", "- winhttp.dll и doorstop_config.ini (загрузчик)", "- winhttp.dll und doorstop_config.ini (der Loader)", "- winhttp.dll و doorstop_config.ini (المحمّل)", "- winhttp.dll 和 doorstop_config.ini（加载器）", "- winhttp.dll e doorstop_config.ini (il loader)", "- winhttp.dll și doorstop_config.ini (încărcătorul)", "- winhttp.dll és doorstop_config.ini (a betöltő)") + "\n" +
            T("- la sauvegarde de reference REC-BLUE-Backup", "- the REC-BLUE-Backup reference copy", "- la copia de referencia REC-BLUE-Backup", "- резервная копия REC-BLUE-Backup", "- die Referenzkopie REC-BLUE-Backup", "- النسخة المرجعية REC-BLUE-Backup", "- 参考备份 REC-BLUE-Backup", "- la copia di riferimento REC-BLUE-Backup", "- copia de referință REC-BLUE-Backup", "- a REC-BLUE-Backup referenciamásolat") + "\n\n" +
            T("Les fichiers du jeu (RecRoom.exe, GameAssembly.dll) et tes donnees sont conserves.", "The game files (RecRoom.exe, GameAssembly.dll) and your data are kept.", "Los archivos del juego (RecRoom.exe, GameAssembly.dll) y tus datos se conservan.", "Файлы игры (RecRoom.exe, GameAssembly.dll) и ваши данные сохраняются.", "Die Spieldateien (RecRoom.exe, GameAssembly.dll) und deine Daten bleiben erhalten.", "تُحفظ ملفات اللعبة (RecRoom.exe و GameAssembly.dll) وبياناتك.", "游戏文件（RecRoom.exe、GameAssembly.dll）和你的数据会保留。", "I file del gioco (RecRoom.exe, GameAssembly.dll) e i tuoi dati restano.", "Fișierele jocului (RecRoom.exe, GameAssembly.dll) și datele tale rămân.", "A játékfájlok (RecRoom.exe, GameAssembly.dll) és az adataid megmaradnak.");
        // Le profil 2025 ne touche ni BepInEx ni winhttp.dll : la liste affichee doit
        // correspondre aux seuls fichiers que la desinstallation supprime vraiment.
        if (Selected.Injector)
        {
            message = MaintText("Supprimer l installation REC BLUE 2025 de :", "Remove the REC BLUE 2025 installation from:") + "\n" + GameDir + "\n\n" +
                MaintText("Seront supprimes : le patch 2025, l injecteur, sa configuration, les lanceurs et la sauvegarde REC-BLUE-Backup.", "The following will be deleted: the 2025 patch, the injector, its configuration, the launchers and the REC-BLUE-Backup copy.") + "\n\n" +
                MaintText("Les fichiers du jeu et tes donnees sont conserves.", "The game files and your data are kept.");
        }
        DialogResult answer = MessageBox.Show(owner, message, T("Desinstaller REC BLUE", "Uninstall REC BLUE", "Desinstalar REC BLUE", "Удалить REC BLUE", "REC BLUE deinstallieren", "إلغاء تثبيت REC BLUE", "卸载 REC BLUE", "Disinstalla REC BLUE", "Dezinstalează REC BLUE", "REC BLUE eltávolítása"),
            MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
        if (answer != DialogResult.Yes) return;

        int removed = 0;
        if (Selected.Injector)
        {
            string backupDir = Path.Combine(GameDir, "REC-BLUE-Backup");
            try
            {
                if (Directory.Exists(backupDir)) { Directory.Delete(backupDir, true); removed++; }
            }
            catch (Exception error) { WriteLog("desinstallation : REC-BLUE-Backup - " + error.Message); }
            for (int i = 0; i < Selected.PackFiles.Length; i++)
            {
                string relative = Selected.PackFiles[i].Path;
                string path = Path.Combine(GameDir, relative);
                try
                {
                    if (File.Exists(path)) { File.Delete(path); removed++; }
                }
                catch (Exception error) { WriteLog("desinstallation : " + relative + " - " + error.Message); }
            }
        }
        else
        {
            string[] folders = new string[] { "BepInEx", "REC-BLUE-Backup" };
            for (int i = 0; i < folders.Length; i++)
            {
                string path = Path.Combine(GameDir, folders[i]);
                try
                {
                    if (Directory.Exists(path)) { Directory.Delete(path, true); removed++; }
                }
                catch (Exception error) { WriteLog("desinstallation : " + folders[i] + " - " + error.Message); }
            }
            string[] files = new string[] { "winhttp.dll", "doorstop_config.ini" };
            for (int i = 0; i < files.Length; i++)
            {
                string path = Path.Combine(GameDir, files[i]);
                try
                {
                    if (File.Exists(path)) { File.Delete(path); removed++; }
                }
                catch (Exception error) { WriteLog("desinstallation : " + files[i] + " - " + error.Message); }
            }
        }

        WriteLog("desinstallation : " + removed + " elements supprimes dans " + GameDir);
        Status = T("Desinstallation terminee (", "Uninstall complete (", "Desinstalación completada (", "Удаление завершено (", "Deinstallation abgeschlossen (", "اكتمل إلغاء التثبيت (", "卸载完成（", "Disinstallazione completata (", "Dezinstalare finalizată (", "Eltávolítás kész (") + removed +
            T(" elements supprimes) - le jeu n est plus relie a REC BLUE.", " items removed) - the game is no longer linked to REC BLUE.", " elementos eliminados): el juego ya no está vinculado a REC BLUE.", " элементов удалено) — игра больше не связана с REC BLUE.", " Elemente entfernt) – das Spiel ist nicht mehr mit REC BLUE verbunden.", " عناصر محذوفة) - لم تعد اللعبة مرتبطة بـ REC BLUE.", " 项已删除），游戏已与 REC BLUE 解除关联。", " elementi rimossi): il gioco non è più collegato a REC BLUE.", " elemente șterse) - jocul nu mai este legat de REC BLUE.", " elem eltávolítva) – a játék többé nem kapcsolódik a REC BLUE-hoz.");
    }

    private static double Stage(Graphics g, int frames, Action<Graphics> draw)
    {
        long start = Clock.ElapsedTicks;
        for (int i = 0; i < frames; i++) draw(g);
        long ticks = Clock.ElapsedTicks - start;
        return ticks * 1000.0 / Stopwatch.Frequency / frames;
    }

    private static void CheckServerAsync(Canvas panel)
    {
        Thread worker = new Thread(delegate()
        {
            bool ok = false;
            int ms = -1;
            Stopwatch ping = Stopwatch.StartNew();
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("https://ns.recblue.net");
                request.Timeout = 8000;
                using (WebResponse response = request.GetResponse())
                {
                    ok = (int)((HttpWebResponse)response).StatusCode >= 200;
                }
            }
            catch { ok = false; }
            ping.Stop();
            if (ok) ms = (int)Math.Round(ping.Elapsed.TotalMilliseconds);

            ServerOk = ok;
            ServerMs = ms;
            ServerChecked = true;
            List<string> problems = GetProblems();
            Status = (ok
                ? T("Serveur : en ligne", "Server: online", "Servidor: en línea", "Сервер: онлайн", "Server: online", "الخادم: متصل", "服务器：在线", "Server: online", "Server: online", "Szerver: online")
                : T("Serveur : injoignable", "Server: unreachable", "Servidor: inaccesible", "Сервер: недоступен", "Server: nicht erreichbar", "الخادم: غير متاح", "服务器：无法访问", "Server: irraggiungibile", "Server: inaccesibil", "Szerver: nem elérhető"))
                + (ms >= 0 ? "  •  " + ms + " ms" : "")
                + "  -  " +
                (problems.Count == 0
                    ? T("fichiers OK", "Files OK", "archivos OK", "файлы в порядке", "Dateien OK", "الملفات سليمة", "文件正常", "file OK", "fișiere OK", "fájlok rendben")
                    : problems[0]);
            ServerStatusText = Status;
            WriteLog(Status);

            try { panel.BeginInvoke((MethodInvoker)delegate { panel.Invalidate(); }); }
            catch { }
        });
        worker.IsBackground = true;
        worker.Start();
    }

    // Etat et latence du serveur, mesures de nouveau toutes les 20 s : la pastille
    // affiche la latence courante. Elle ne remplace la ligne que si celle-ci porte
    // encore l'etat du serveur, pour ne pas ecraser un message d'installation.
    private static void WatchServerAsync(Canvas panel)
    {
        Thread watch = new Thread(delegate()
        {
            while (FrameClockRunning)
            {
                Thread.Sleep(20000);
                if (!FrameClockRunning) return;
                if (Status != ServerStatusText) continue;
                CheckServerAsync(panel);
            }
        });
        watch.IsBackground = true;
        watch.Start();
    }

    private static void LoadLogoFont()
    {
        LogoFamily = null;
        try
        {
            string path = Path.Combine(GameDir, "futura-extra-bold.ttf");
            if (File.Exists(path))
            {
                PrivateFontCollection fonts = new PrivateFontCollection();
                fonts.AddFontFile(path);
                if (fonts.Families.Length > 0) LogoFamily = fonts.Families[0];
            }
        }
        catch { }
        if (LogoFamily == null) LogoFamily = new FontFamily("Arial");
    }
}
