using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;

namespace RecNetPlugin.Patches;

/**
    Photon connection probe.

    PUN is compiled NATIVELY in this build: the interop assemblies expose no
    LoadBalancingClient, no PhotonNetwork and no DisconnectCause (checked by dumping every
    type in PhotonRealtime/PhotonUnityNetworking/Photon3Unity3D), so Harmony cannot read
    PUN's DisconnectCause. What CAN be observed is the transport: Photon's UDP sockets in
    this process. This probe samples the Windows UDP table every 500 ms and logs a line
    each time the set of local ports owned by RecRoom changes — the socket opening at
    boot, and the exact millisecond the disconnect closes it.

    Correlate a `closed` line with the plugin's HTTP trace (`[HTTP]`) and the server's
    heartbeat to see whether the client dropped before or after the room load.
 */
public static class PhotonSocketProbe
{
    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedUdpTable(
        IntPtr pUdpTable, ref int pdwSize, bool bOrder, int ulAf, int tableClass, uint reserved);

    private const int AfInet = 2;
    private const int UdpTableOwnerPid = 1;
    private const int ErrorInsufficientBuffer = 122;

    private static readonly object Gate = new object();
    private static Timer _timer;
    private static string _last = "";
    private static bool _failed;

    // The last HTTP request the client made. SendRequestPatch calls NoteHttp on every request, so
    // a socket change can name the phase it happened in (boot, room load, heartbeat, …) without
    // needing the HTTP log (which only exists with Debug on).
    private static volatile string _lastHttp = "<aucune>";
    private static long _lastHttpTicks;

    /** Idempotent: Plugin.Load calls it once. A background timer keeps it off the Unity thread. */
    public static void Start()
    {
        lock (Gate)
        {
            if (_timer != null) return;
            _timer = new Timer(_ => Poll(), null, 500, 500);
            Plugin.Log.LogWarning("[PHOTON-PROBE] started (UDP table watcher, 500 ms)");
        }
    }

    /** Called by SendRequestPatch for every request: the probe line then names the phase. */
    public static void NoteHttp(string what)
    {
        _lastHttp = what;
        Interlocked.Exchange(ref _lastHttpTicks, DateTime.Now.Ticks);
    }

    private static void Poll()
    {
        try
        {
            var ports = UdpPorts((uint)Environment.ProcessId).OrderBy(p => p).ToArray();
            var signature = string.Join(",", ports);
            if (signature == _last) return;
            _last = signature;
            var ticks = Interlocked.Read(ref _lastHttpTicks);
            var http = ticks == 0
                ? "<aucune>"
                : $"{_lastHttp}@{new DateTime(ticks):HH:mm:ss.fff}";
            Plugin.Log.LogWarning(
                $"[PHOTON-PROBE] udp count={ports.Length} ports=[{signature}] lastHttp={http} t={DateTime.Now:HH:mm:ss.fff}");
        }
        catch (Exception e)
        {
            if (_failed) return;
            _failed = true;
            Plugin.Log.LogWarning($"[PHOTON-PROBE] watcher failed: {e.GetType().Name}: {e.Message}");
        }
    }

    /** Local UDP ports owned by `pid` (IPv4). A UDP row carries no peer, only the local side. */
    private static List<int> UdpPorts(uint pid)
    {
        var ports = new List<int>();
        int size = 0;
        var rc = GetExtendedUdpTable(IntPtr.Zero, ref size, false, AfInet, UdpTableOwnerPid, 0);
        if (rc != ErrorInsufficientBuffer || size <= 0) return ports;

        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            rc = GetExtendedUdpTable(buffer, ref size, false, AfInet, UdpTableOwnerPid, 0);
            if (rc != 0) return ports;

            var rows = Marshal.ReadInt32(buffer);
            var row = IntPtr.Add(buffer, 4);
            // MIB_UDPROW_OWNER_PID: dwLocalAddr (4), dwLocalPort (4), dwOwningPid (4).
            for (var i = 0; i < rows; i++, row = IntPtr.Add(row, 12))
            {
                var owner = (uint)Marshal.ReadInt32(row, 8);
                if (owner != pid) continue;
                var rawPort = (uint)Marshal.ReadInt32(row, 4);
                // The port is stored in network byte order in the low 16 bits.
                var port = (int)(((rawPort & 0xFF) << 8) | ((rawPort >> 8) & 0xFF));
                ports.Add(port);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return ports;
    }
}
