using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace RingWatchWindows
{
    public class ServiceConfig
    {
        public int port = 3456;
        public string host = "0.0.0.0";
        public string dataDir = "";
        public string recordingsDir = "";
        public string logsDir = "";
        public string authPassword = "";
        public bool debugLogging = false;
    }

    public class RingWatchNvrService : ServiceBase
    {
        public const string SERVICE_NAME = "RingWatchNvrService";
        private const long MAX_LOG_BYTES = 5 * 1024 * 1024;
        private const int MAX_LOG_ARCHIVES = 3;

        private readonly string baseDir;
        private readonly object logLock = new object();
        private volatile bool stopping = false;
        private Thread supervisorThread;
        private Process childProcess;
        private string activeControlToken;
        private ServiceConfig config;

        public RingWatchNvrService()
        {
            ServiceName = SERVICE_NAME;
            CanStop = true;
            CanShutdown = true;
            AutoLog = true;
            baseDir = AppDomain.CurrentDomain.BaseDirectory;
        }

        private ServiceConfig LoadConfig()
        {
            ServiceConfig cfg = new ServiceConfig();
            string configPath = Path.Combine(baseDir, "RingWatchService.config.json");
            if (File.Exists(configPath))
            {
                try
                {
                    string raw = File.ReadAllText(configPath, Encoding.UTF8);
                    JavaScriptSerializer ser = new JavaScriptSerializer();
                    Dictionary<string, object> dict = ser.Deserialize<Dictionary<string, object>>(raw);
                    if (dict != null)
                    {
                        if (dict.ContainsKey("port") && dict["port"] != null)
                        {
                            int p;
                            if (int.TryParse(dict["port"].ToString(), out p) && p > 0) cfg.port = p;
                        }
                        if (dict.ContainsKey("host") && dict["host"] != null && !string.IsNullOrWhiteSpace(dict["host"].ToString()))
                        {
                            cfg.host = dict["host"].ToString().Trim();
                        }
                        if (dict.ContainsKey("dataDir") && dict["dataDir"] != null)
                        {
                            cfg.dataDir = dict["dataDir"].ToString().Trim();
                        }
                        if (dict.ContainsKey("recordingsDir") && dict["recordingsDir"] != null)
                        {
                            cfg.recordingsDir = dict["recordingsDir"].ToString().Trim();
                        }
                        if (dict.ContainsKey("logsDir") && dict["logsDir"] != null)
                        {
                            cfg.logsDir = dict["logsDir"].ToString().Trim();
                        }
                        if (dict.ContainsKey("authPassword") && dict["authPassword"] != null)
                        {
                            cfg.authPassword = dict["authPassword"].ToString().Trim();
                        }
                        if (dict.ContainsKey("debugLogging") && dict["debugLogging"] != null)
                        {
                            bool dbg;
                            if (bool.TryParse(dict["debugLogging"].ToString(), out dbg)) cfg.debugLogging = dbg;
                        }
                    }
                }
                catch (Exception ex)
                {
                    WriteLog("WARN", "Failed to parse RingWatchService.config.json: " + ex.Message);
                }
            }

            if (string.IsNullOrWhiteSpace(cfg.dataDir))
            {
                string programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
                cfg.dataDir = Path.Combine(programData, "RingWatch");
            }
            if (string.IsNullOrWhiteSpace(cfg.recordingsDir))
            {
                cfg.recordingsDir = Path.Combine(cfg.dataDir, "Recordings");
            }
            if (string.IsNullOrWhiteSpace(cfg.logsDir))
            {
                cfg.logsDir = Path.Combine(cfg.dataDir, "logs");
            }
            return cfg;
        }

        private string GetServiceLogPath()
        {
            string dir = (config != null && !string.IsNullOrWhiteSpace(config.logsDir))
                ? config.logsDir
                : Path.Combine(baseDir, "logs");
            Directory.CreateDirectory(dir);
            return Path.Combine(dir, "ringwatch-service.log");
        }

        private void WriteLog(string level, string message)
        {
            lock (logLock)
            {
                try
                {
                    string logPath = GetServiceLogPath();
                    if (File.Exists(logPath))
                    {
                        FileInfo fi = new FileInfo(logPath);
                        if (fi.Length >= MAX_LOG_BYTES)
                        {
                            string dir = Path.GetDirectoryName(logPath);
                            for (int i = MAX_LOG_ARCHIVES; i >= 1; i--)
                            {
                                string src = (i == 1)
                                    ? logPath
                                    : Path.Combine(dir, string.Format("ringwatch-service.{0}.log", i - 1));
                                string dst = Path.Combine(dir, string.Format("ringwatch-service.{0}.log", i));
                                if (File.Exists(src))
                                {
                                    try
                                    {
                                        if (File.Exists(dst)) File.Delete(dst);
                                        File.Move(src, dst);
                                    }
                                    catch { }
                                }
                            }
                        }
                    }

                    string line = string.Format("[{0}] [SERVICE:{1}] {2}{3}",
                        DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
                        level,
                        message,
                        Environment.NewLine);
                    File.AppendAllText(logPath, line, Encoding.UTF8);
                }
                catch { }
            }
        }

        private string ResolveNodeExe()
        {
            string bundled = Path.Combine(baseDir, "runtime", "node.exe");
            if (File.Exists(bundled)) return bundled;

            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string sysNode = Path.Combine(pf, "nodejs", "node.exe");
            if (File.Exists(sysNode)) return sysNode;

            return "node.exe";
        }

        protected override void OnStart(string[] args)
        {
            stopping = false;
            config = LoadConfig();
            Directory.CreateDirectory(config.dataDir);
            Directory.CreateDirectory(config.logsDir);

            WriteLog("INFO", string.Format("RingWatch Windows Service starting (Port={0}, DataDir={1}, Debug={2})",
                config.port, config.dataDir, config.debugLogging));

            supervisorThread = new Thread(SupervisorLoop);
            supervisorThread.IsBackground = true;
            supervisorThread.Start();
        }

        private void SupervisorLoop()
        {
            int consecutiveFastExits = 0;

            while (!stopping)
            {
                config = LoadConfig();
                string nodeExe = ResolveNodeExe();
                string entryJs = Path.Combine(baseDir, "dist-server", "server", "index.js");

                if (!File.Exists(entryJs))
                {
                    WriteLog("ERROR", "Backend entrypoint missing: " + entryJs);
                    SleepInterruptible(10000);
                    continue;
                }

                activeControlToken = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
                DateTime startedUtc = DateTime.UtcNow;

                try
                {
                    ProcessStartInfo psi = new ProcessStartInfo();
                    psi.FileName = nodeExe;
                    psi.Arguments = "\"" + entryJs + "\"";
                    psi.WorkingDirectory = baseDir;
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;
                    psi.RedirectStandardOutput = true;
                    psi.RedirectStandardError = true;

                    psi.EnvironmentVariables["PORT"] = config.port.ToString();
                    psi.EnvironmentVariables["HOST"] = config.host;
                    psi.EnvironmentVariables["RINGWATCH_DATA_DIR"] = config.dataDir;
                    psi.EnvironmentVariables["RINGWATCH_RECORDINGS_DIR"] = config.recordingsDir;
                    psi.EnvironmentVariables["RINGWATCH_LOG_DIR"] = config.logsDir;
                    psi.EnvironmentVariables["RINGWATCH_DEBUG"] = config.debugLogging ? "1" : "0";
                    psi.EnvironmentVariables["RINGWATCH_CONTROL_TOKEN"] = activeControlToken;
                    if (!string.IsNullOrWhiteSpace(config.authPassword))
                    {
                        psi.EnvironmentVariables["RINGWATCH_AUTH_PASSWORD"] = config.authPassword;
                    }

                    Process proc = new Process();
                    proc.StartInfo = psi;
                    proc.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
                    {
                        if (!string.IsNullOrEmpty(e.Data)) WriteLog("STDOUT", e.Data);
                    };
                    proc.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
                    {
                        if (!string.IsNullOrEmpty(e.Data)) WriteLog("STDERR", e.Data);
                    };

                    WriteLog("INFO", "Launching backend: " + nodeExe + " " + psi.Arguments);
                    proc.Start();
                    childProcess = proc;
                    proc.BeginOutputReadLine();
                    proc.BeginErrorReadLine();
                    proc.WaitForExit();

                    int code = proc.ExitCode;
                    childProcess = null;

                    if (stopping)
                    {
                        WriteLog("INFO", "Backend exited cleanly during service stop (exit code " + code + ").");
                        break;
                    }

                    double ranSeconds = (DateTime.UtcNow - startedUtc).TotalSeconds;
                    if (ranSeconds < 15.0)
                    {
                        consecutiveFastExits++;
                    }
                    else
                    {
                        consecutiveFastExits = 0;
                    }

                    int delayMs = consecutiveFastExits <= 1 ? 3000 : (consecutiveFastExits <= 3 ? 10000 : 30000);
                    WriteLog("WARN", string.Format("Backend exited unexpectedly (code {0}, ran {1:F1}s). Restarting in {2}s...",
                        code, ranSeconds, delayMs / 1000));
                    SleepInterruptible(delayMs);
                }
                catch (Exception ex)
                {
                    childProcess = null;
                    WriteLog("ERROR", "Failed to launch backend process: " + ex.Message);
                    SleepInterruptible(10000);
                }
            }
        }

        private void SleepInterruptible(int totalMs)
        {
            int elapsed = 0;
            while (!stopping && elapsed < totalMs)
            {
                Thread.Sleep(250);
                elapsed += 250;
            }
        }

        private void RequestGracefulShutdown()
        {
            if (config == null || string.IsNullOrEmpty(activeControlToken)) return;
            try
            {
                string url = string.Format("http://127.0.0.1:{0}/api/internal/shutdown", config.port);
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "POST";
                req.Timeout = 2500;
                req.ContentLength = 0;
                req.Headers["X-RingWatch-Control"] = activeControlToken;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    WriteLog("INFO", "Graceful shutdown acknowledged by backend (HTTP " + (int)resp.StatusCode + ").");
                }
            }
            catch (Exception ex)
            {
                WriteLog("WARN", "Graceful shutdown request failed (will terminate process tree): " + ex.Message);
            }
        }

        private void KillProcessTree(int pid)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "taskkill.exe";
                psi.Arguments = string.Format("/PID {0} /T /F", pid);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                using (Process tk = Process.Start(psi))
                {
                    if (tk != null) tk.WaitForExit(4000);
                }
            }
            catch { }
        }

        private void StopBackend()
        {
            stopping = true;
            WriteLog("INFO", "RingWatch Windows Service stopping...");

            Process proc = childProcess;
            if (proc != null)
            {
                try
                {
                    if (!proc.HasExited)
                    {
                        RequestGracefulShutdown();
                        if (!proc.WaitForExit(6000))
                        {
                            WriteLog("WARN", "Backend did not exit within 6s; terminating process tree (PID " + proc.Id + ").");
                            KillProcessTree(proc.Id);
                        }
                    }
                }
                catch (Exception ex)
                {
                    WriteLog("WARN", "Error stopping child backend process: " + ex.Message);
                }
            }

            if (supervisorThread != null && supervisorThread.IsAlive)
            {
                supervisorThread.Join(3000);
            }

            WriteLog("INFO", "RingWatch Windows Service stopped.");
        }

        protected override void OnStop()
        {
            RequestAdditionalTime(10000);
            StopBackend();
        }

        protected override void OnShutdown()
        {
            StopBackend();
        }

        public static void Main(string[] args)
        {
            ServiceBase.Run(new RingWatchNvrService());
        }
    }
}
