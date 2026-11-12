using System;
using ExitGames.Client.Photon;
using HarmonyLib;
using Photon.Realtime;

namespace RecNetPlugin.Patches;

/**
    Patches Photon to use the App IDs and server hostname/port specified in the plugin config.
 */
// Obfuscated names shift every game build. Re-resolve by signature: the target is the only
// instance, 0-param method returning Photon.Realtime.AppSettings in Assembly-CSharp.
// 20230414 build: HPEENKELKDJ.MGKINLFMJLB (was LEALBOODIEE.GBNKOFMAJPA, was GPFPFDBGCEK.AMOHMPKKGHL).
[HarmonyPatch(typeof(HPEENKELKDJ), "MGKINLFMJLB")]
public class PhotonPatches
{
    [HarmonyPostfix]
    private static void Postfix(ref AppSettings __result)
    {
        if (__result != null)
        {
            Plugin.Log.LogInfo(
                $"[PHOTON] settings before: appId={Short(__result.AppIdRealtime)} region='{__result.FixedRegion}' " +
                $"useNameServer={__result.UseNameServer} server='{__result.Server}' port={__result.Port} proto={__result.Protocol}");

            __result.AppIdRealtime = Plugin.AppIdRT.Value;
            __result.AppIdVoice = Plugin.AppIdVoice.Value;
            __result.AppIdChat = Plugin.AppIdChat.Value;
            __result.Protocol = ConnectionProtocol.Udp;

            // A custom Photon host (self-hosted server) must be dialled DIRECTLY: with
            // UseNameServer = true the client asks the public Photon name server for the
            // region and the configured Server/Port are ignored, so the connect goes to
            // the cloud with an app id the local server never sees and PUN drops it.
            if (Plugin.EnableAdvancedSettings.Value && !string.IsNullOrWhiteSpace(Plugin.PhotonHostname.Value))
            {
                __result.UseNameServer = false;
                __result.Server = Plugin.PhotonHostname.Value;
                __result.Port = Plugin.PhotonPort.Value == 0
                    ? 4533
                    : Plugin.PhotonPort.Value;
            }
            else
            {
                __result.FixedRegion = "us";
                __result.UseNameServer = true;
            }

            Plugin.Log.LogInfo(
                $"[PHOTON] settings after: appId={Short(__result.AppIdRealtime)} region='{__result.FixedRegion}' " +
                $"useNameServer={__result.UseNameServer} server='{__result.Server}' port={__result.Port} proto={__result.Protocol}");
        }
    }

    private static string Short(string id) =>
        string.IsNullOrEmpty(id) ? "<vide>" : id.Substring(0, Math.Min(8, id.Length)) + "…";
}
