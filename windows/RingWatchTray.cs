using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace RingWatchWindows
{
    public class TrayConfig
    {
        public int port = 3456;
        public string host = "0.0.0.0";
        public string dataDir = "";
        public string recordingsDir = "";
        public string logsDir = "";
        public bool debugLogging = false;
    }

    public class LogViewerForm : Form
    {
        private readonly Func<string> loadLogsFn;
        private readonly Action exportLogsFn;
        private readonly Action openLogsDirFn;
        private readonly TextBox textBox;
        private readonly CheckBox autoRefreshCheck;
        private readonly System.Windows.Forms.Timer refreshTimer;

        public LogViewerForm(Func<string> loadLogsFn, Action exportLogsFn, Action openLogsDirFn)
        {
            this.loadLogsFn = loadLogsFn;
            this.exportLogsFn = exportLogsFn;
            this.openLogsDirFn = openLogsDirFn;

            Text = "RingWatch NVR & AI — Troubleshooting Logs";
            Width = 960;
            Height = 620;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(18, 22, 28);
            ForeColor = Color.FromArgb(228, 234, 242);

            Panel topBar = new Panel();
            topBar.Dock = DockStyle.Top;
            topBar.Height = 44;
            topBar.Padding = new Padding(10, 7, 10, 7);
            topBar.BackColor = Color.FromArgb(26, 31, 40);

            Button btnRefresh = CreateButton("Refresh", 10, 8, 86);
            btnRefresh.Click += delegate { RefreshLogs(true); };

            Button btnCopy = CreateButton("Copy All", 104, 8, 90);
            btnCopy.Click += delegate
            {
                if (!string.IsNullOrEmpty(textBox.Text))
                {
                    Clipboard.SetText(textBox.Text);
                }
            };

            Button btnExport = CreateButton("Export Troubleshooting Log...", 202, 8, 200);
            btnExport.BackColor = Color.FromArgb(37, 99, 235);
            btnExport.Click += delegate { this.exportLogsFn(); };

            Button btnFolder = CreateButton("Open Logs Folder", 410, 8, 136);
            btnFolder.Click += delegate { this.openLogsDirFn(); };

            autoRefreshCheck = new CheckBox();
            autoRefreshCheck.Text = "Auto-refresh (2s)";
            autoRefreshCheck.Checked = true;
            autoRefreshCheck.AutoSize = true;
            autoRefreshCheck.Location = new Point(560, 12);
            autoRefreshCheck.ForeColor = Color.FromArgb(200, 210, 225);

            topBar.Controls.Add(btnRefresh);
            topBar.Controls.Add(btnCopy);
            topBar.Controls.Add(btnExport);
            topBar.Controls.Add(btnFolder);
            topBar.Controls.Add(autoRefreshCheck);

            textBox = new TextBox();
            textBox.Dock = DockStyle.Fill;
            textBox.Multiline = true;
            textBox.ReadOnly = true;
            textBox.ScrollBars = ScrollBars.Both;
            textBox.WordWrap = false;
            textBox.Font = new Font("Consolas", 9.5f);
            textBox.BackColor = Color.FromArgb(13, 17, 23);
            textBox.ForeColor = Color.FromArgb(220, 228, 238);
            textBox.BorderStyle = BorderStyle.None;

            Controls.Add(textBox);
            Controls.Add(topBar);

            refreshTimer = new System.Windows.Forms.Timer();
            refreshTimer.Interval = 2000;
            refreshTimer.Tick += delegate
            {
                if (autoRefreshCheck.Checked && Visible)
                {
                    RefreshLogs(false);
                }
            };
            refreshTimer.Start();

            FormClosing += delegate(object s, FormClosingEventArgs e)
            {
                refreshTimer.Stop();
            };

            RefreshLogs(true);
        }

        private Button CreateButton(string text, int x, int y, int width)
        {
            Button btn = new Button();
            btn.Text = text;
            btn.Location = new Point(x, y);
            btn.Size = new Size(width, 28);
            btn.FlatStyle = FlatStyle.Flat;
            btn.FlatAppearance.BorderColor = Color.FromArgb(55, 65, 81);
            btn.BackColor = Color.FromArgb(38, 46, 59);
            btn.ForeColor = Color.White;
            btn.Cursor = Cursors.Hand;
            return btn;
        }

        public void RefreshLogs(bool scrollToBottom)
        {
            try
            {
                string content = loadLogsFn();
                if (textBox.Text != content)
                {
                    textBox.Text = content;
                    if (scrollToBottom || autoRefreshCheck.Checked)
                    {
                        textBox.SelectionStart = textBox.TextLength;
                        textBox.ScrollToCaret();
                    }
                }
            }
            catch { }
        }
    }

    public class RingWatchTrayContext : ApplicationContext
    {
        private const string SERVICE_NAME = "RingWatchNvrService";

        private readonly string baseDir;
        private readonly NotifyIcon trayIcon;
        private readonly ContextMenuStrip menu;
        private readonly ToolStripMenuItem statusItem;
        private readonly ToolStripMenuItem openUiItem;
        private readonly ToolStripMenuItem startItem;
        private readonly ToolStripMenuItem stopItem;
        private readonly ToolStripMenuItem restartItem;
        private readonly ToolStripMenuItem debugItem;
        private readonly ToolStripMenuItem installServiceItem;
        private readonly System.Windows.Forms.Timer pollTimer;

        private readonly Icon iconRunning;
        private readonly Icon iconBusy;
        private readonly Icon iconStopped;

        private TrayConfig config;
        private volatile bool actionBusy = false;
        private volatile bool pollRunning = false;
        private LogViewerForm logViewer;

        public RingWatchTrayContext()
        {
            baseDir = AppDomain.CurrentDomain.BaseDirectory;
            config = LoadConfig();

            Icon baseAppIcon = LoadBaseIcon();
            iconRunning = CreateBadgedIcon(baseAppIcon, Color.FromArgb(34, 197, 94));   // Green
            iconBusy = CreateBadgedIcon(baseAppIcon, Color.FromArgb(245, 158, 11));     // Amber
            iconStopped = CreateBadgedIcon(baseAppIcon, Color.FromArgb(239, 68, 68));   // Red

            menu = new ContextMenuStrip();

            statusItem = new ToolStripMenuItem("Checking RingWatch Backend...");
            statusItem.Enabled = false;
            statusItem.Font = new Font(statusItem.Font, FontStyle.Bold);

            openUiItem = new ToolStripMenuItem("Open RingWatch Web UI");
            openUiItem.Click += delegate { OpenWebUi(); };

            startItem = new ToolStripMenuItem("Start Backend Service");
            startItem.Click += delegate { RunServiceAction("start"); };

            stopItem = new ToolStripMenuItem("Stop Backend Service");
            stopItem.Click += delegate { RunServiceAction("stop"); };

            restartItem = new ToolStripMenuItem("Restart Backend Service");
            restartItem.Click += delegate { RunServiceAction("restart"); };

            ToolStripMenuItem viewLogsItem = new ToolStripMenuItem("View Live Logs...");
            viewLogsItem.Click += delegate { ShowLogViewer(); };

            ToolStripMenuItem exportLogsItem = new ToolStripMenuItem("Export Troubleshooting Log...");
            exportLogsItem.Click += delegate { ExportTroubleshootingLog(); };

            ToolStripMenuItem openLogsFolderItem = new ToolStripMenuItem("Open Logs Folder");
            openLogsFolderItem.Click += delegate { OpenLogsFolder(); };

            debugItem = new ToolStripMenuItem("Verbose Debug Logging");
            debugItem.CheckOnClick = false;
            debugItem.Checked = config.debugLogging;
            debugItem.Click += delegate { ToggleDebugLogging(); };

            installServiceItem = new ToolStripMenuItem("Install Windows Service...");
            installServiceItem.Click += delegate { RunServiceInstaller(); };

            ToolStripMenuItem exitItem = new ToolStripMenuItem("Exit Tray Icon");
            exitItem.Click += delegate { ExitTray(); };

            menu.Items.Add(statusItem);
            menu.Items.Add(openUiItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(startItem);
            menu.Items.Add(stopItem);
            menu.Items.Add(restartItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(viewLogsItem);
            menu.Items.Add(exportLogsItem);
            menu.Items.Add(openLogsFolderItem);
            menu.Items.Add(debugItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(installServiceItem);
            menu.Items.Add(exitItem);

            trayIcon = new NotifyIcon();
            trayIcon.Icon = iconBusy;
            trayIcon.Text = "RingWatch NVR & AI Backend";
            trayIcon.ContextMenuStrip = menu;
            trayIcon.Visible = true;
            trayIcon.DoubleClick += delegate { OpenWebUi(); };

            pollTimer = new System.Windows.Forms.Timer();
            pollTimer.Interval = 2500;
            pollTimer.Tick += delegate { PollStatusAsync(); };
            pollTimer.Start();

            PollStatusAsync();
        }

        private Icon LoadBaseIcon()
        {
            try
            {
                string icoPath = Path.Combine(baseDir, "build", "icon.ico");
                if (File.Exists(icoPath)) return new Icon(icoPath, 32, 32);
                Icon exeIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (exeIcon != null) return exeIcon;
            }
            catch { }
            return SystemIcons.Shield;
        }

        private Icon CreateBadgedIcon(Icon baseIcon, Color dotColor)
        {
            Bitmap bmp = new Bitmap(32, 32);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                g.DrawIcon(baseIcon, new Rectangle(0, 0, 30, 30));

                Rectangle ringRect = new Rectangle(18, 18, 13, 13);
                using (SolidBrush bg = new SolidBrush(Color.FromArgb(20, 24, 30)))
                {
                    g.FillEllipse(bg, ringRect);
                }
                Rectangle dotRect = new Rectangle(20, 20, 9, 9);
                using (SolidBrush dot = new SolidBrush(dotColor))
                {
                    g.FillEllipse(dot, dotRect);
                }
            }
            IntPtr hIcon = bmp.GetHicon();
            return Icon.FromHandle(hIcon);
        }

        private TrayConfig LoadConfig()
        {
            TrayConfig cfg = new TrayConfig();
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
                        if (dict.ContainsKey("debugLogging") && dict["debugLogging"] != null)
                        {
                            bool dbg;
                            if (bool.TryParse(dict["debugLogging"].ToString(), out dbg)) cfg.debugLogging = dbg;
                        }
                    }
                }
                catch { }
            }

            if (string.IsNullOrWhiteSpace(cfg.dataDir))
            {
                string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
                cfg.dataDir = Path.Combine(appData, "RingWatch");
            }
            if (string.IsNullOrWhiteSpace(cfg.logsDir))
            {
                cfg.logsDir = Path.Combine(cfg.dataDir, "logs");
            }
            return cfg;
        }

        private void SaveDebugSetting(bool enabled)
        {
            string configPath = Path.Combine(baseDir, "RingWatchService.config.json");
            Dictionary<string, object> dict = new Dictionary<string, object>();
            JavaScriptSerializer ser = new JavaScriptSerializer();
            if (File.Exists(configPath))
            {
                try
                {
                    Dictionary<string, object> loaded = ser.Deserialize<Dictionary<string, object>>(
                        File.ReadAllText(configPath, Encoding.UTF8));
                    if (loaded != null) dict = loaded;
                }
                catch { }
            }
            dict["port"] = config.port;
            dict["host"] = config.host;
            dict["dataDir"] = config.dataDir;
            if (!string.IsNullOrWhiteSpace(config.recordingsDir)) dict["recordingsDir"] = config.recordingsDir;
            dict["logsDir"] = config.logsDir;
            dict["debugLogging"] = enabled;

            File.WriteAllText(configPath, ser.Serialize(dict), Encoding.UTF8);
            config.debugLogging = enabled;
        }

        private ServiceControllerStatus? QueryServiceStatus()
        {
            try
            {
                using (ServiceController sc = new ServiceController(SERVICE_NAME))
                {
                    return sc.Status;
                }
            }
            catch
            {
                return null;
            }
        }

        private bool CheckHttpHealth(out string detail)
        {
            detail = "";
            try
            {
                string url = string.Format("http://127.0.0.1:{0}/api/health", config.port);
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "GET";
                req.Timeout = 1500;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                using (StreamReader sr = new StreamReader(resp.GetResponseStream()))
                {
                    detail = sr.ReadToEnd();
                    return resp.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        private void PollStatusAsync()
        {
            if (pollRunning) return;
            pollRunning = true;

            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    config = LoadConfig();
                    ServiceControllerStatus? svcStatus = QueryServiceStatus();
                    string healthJson;
                    bool healthy = CheckHttpHealth(out healthJson);

                    RunOnUi(delegate
                    {
                        debugItem.Checked = config.debugLogging;
                        bool svcInstalled = svcStatus.HasValue;
                        installServiceItem.Visible = !svcInstalled;

                        if (actionBusy)
                        {
                            trayIcon.Icon = iconBusy;
                            trayIcon.Text = "RingWatch Backend — Working...";
                            statusItem.Text = "Working...";
                            startItem.Enabled = false;
                            stopItem.Enabled = false;
                            restartItem.Enabled = false;
                            return;
                        }

                        if (svcStatus.HasValue)
                        {
                            ServiceControllerStatus st = svcStatus.Value;
                            if (st == ServiceControllerStatus.Running)
                            {
                                trayIcon.Icon = healthy ? iconRunning : iconBusy;
                                string stateText = healthy ? "Running" : "Starting";
                                trayIcon.Text = string.Format("RingWatch Backend — {0} (:{1})", stateText, config.port);
                                statusItem.Text = string.Format("● {0} — http://localhost:{1}", stateText, config.port);
                                startItem.Enabled = false;
                                stopItem.Enabled = true;
                                restartItem.Enabled = true;
                            }
                            else if (st == ServiceControllerStatus.StartPending || st == ServiceControllerStatus.StopPending)
                            {
                                trayIcon.Icon = iconBusy;
                                trayIcon.Text = "RingWatch Backend — " + st.ToString();
                                statusItem.Text = "◐ " + st.ToString() + "...";
                                startItem.Enabled = false;
                                stopItem.Enabled = false;
                                restartItem.Enabled = false;
                            }
                            else
                            {
                                trayIcon.Icon = iconStopped;
                                trayIcon.Text = "RingWatch Backend — Stopped";
                                statusItem.Text = "○ Stopped (Windows Service)";
                                startItem.Enabled = true;
                                stopItem.Enabled = false;
                                restartItem.Enabled = false;
                            }
                        }
                        else
                        {
                            if (healthy)
                            {
                                trayIcon.Icon = iconRunning;
                                trayIcon.Text = string.Format("RingWatch Backend — Running (:{0})", config.port);
                                statusItem.Text = string.Format("● Running (Standalone) — :{0}", config.port);
                                startItem.Enabled = false;
                                stopItem.Enabled = false;
                                restartItem.Enabled = false;
                            }
                            else
                            {
                                trayIcon.Icon = iconStopped;
                                trayIcon.Text = "RingWatch Backend — Service Not Installed";
                                statusItem.Text = "○ Service Not Installed";
                                startItem.Enabled = true;
                                stopItem.Enabled = false;
                                restartItem.Enabled = false;
                            }
                        }
                    });
                }
                finally
                {
                    pollRunning = false;
                }
            });
        }

        private void RunOnUi(Action action)
        {
            try
            {
                if (menu != null && menu.InvokeRequired)
                {
                    menu.BeginInvoke(action);
                }
                else
                {
                    action();
                }
            }
            catch { }
        }

        private void RunServiceAction(string action)
        {
            if (actionBusy) return;
            ServiceControllerStatus? current = QueryServiceStatus();
            if (!current.HasValue)
            {
                DialogResult res = MessageBox.Show(
                    "The RingWatch Windows Service is not installed yet.\n\nWould you like to install and start it now?",
                    "RingWatch Service",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question);
                if (res == DialogResult.Yes)
                {
                    RunServiceInstaller();
                }
                return;
            }

            actionBusy = true;
            trayIcon.Icon = iconBusy;
            statusItem.Text = "◐ " + char.ToUpper(action[0]) + action.Substring(1) + "ing service...";

            ThreadPool.QueueUserWorkItem(delegate
            {
                string errorMsg = null;
                try
                {
                    try
                    {
                        using (ServiceController sc = new ServiceController(SERVICE_NAME))
                        {
                            if (action == "stop" || action == "restart")
                            {
                                if (sc.Status != ServiceControllerStatus.Stopped && sc.Status != ServiceControllerStatus.StopPending)
                                {
                                    sc.Stop();
                                }
                                sc.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(20));
                            }
                            if (action == "start" || action == "restart")
                            {
                                sc.Refresh();
                                if (sc.Status != ServiceControllerStatus.Running && sc.Status != ServiceControllerStatus.StartPending)
                                {
                                    sc.Start();
                                }
                                sc.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(20));
                            }
                        }
                    }
                    catch
                    {
                        // Fallback to elevated cmd if current user lacks direct SCM start/stop permission
                        string cmdArgs;
                        if (action == "start") cmdArgs = "/c net start " + SERVICE_NAME;
                        else if (action == "stop") cmdArgs = "/c net stop " + SERVICE_NAME;
                        else cmdArgs = "/c net stop " + SERVICE_NAME + " & net start " + SERVICE_NAME;

                        ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", cmdArgs);
                        psi.Verb = "runas";
                        psi.WindowStyle = ProcessWindowStyle.Hidden;
                        psi.UseShellExecute = true;
                        using (Process p = Process.Start(psi))
                        {
                            if (p != null) p.WaitForExit(25000);
                        }
                    }
                }
                catch (Exception ex)
                {
                    errorMsg = ex.Message;
                }
                finally
                {
                    actionBusy = false;
                    RunOnUi(delegate
                    {
                        if (!string.IsNullOrEmpty(errorMsg))
                        {
                            trayIcon.ShowBalloonTip(4000, "RingWatch Service", "Action failed: " + errorMsg, ToolTipIcon.Error);
                        }
                        else
                        {
                            string past = action == "start" ? "started" : (action == "stop" ? "stopped" : "restarted");
                            trayIcon.ShowBalloonTip(2500, "RingWatch Backend", "Service " + past + " successfully.", ToolTipIcon.Info);
                        }
                        PollStatusAsync();
                    });
                }
            });
        }

        private void OpenWebUi()
        {
            try
            {
                string url = string.Format("http://localhost:{0}", config.port);
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            catch { }
        }

        private void OpenLogsFolder()
        {
            try
            {
                Directory.CreateDirectory(config.logsDir);
                Process.Start(new ProcessStartInfo("explorer.exe", "\"" + config.logsDir + "\"") { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                MessageBox.Show("Could not open logs folder: " + ex.Message, "RingWatch Logs", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private string ReadTailFile(string filePath, int maxLines)
        {
            if (!File.Exists(filePath)) return "(Log file not created yet: " + filePath + ")";
            try
            {
                using (FileStream fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                using (StreamReader sr = new StreamReader(fs, Encoding.UTF8))
                {
                    List<string> lines = new List<string>();
                    string line;
                    while ((line = sr.ReadLine()) != null)
                    {
                        lines.Add(line);
                    }
                    int start = Math.Max(0, lines.Count - maxLines);
                    StringBuilder sb = new StringBuilder();
                    for (int i = start; i < lines.Count; i++)
                    {
                        sb.AppendLine(lines[i]);
                    }
                    return sb.ToString();
                }
            }
            catch (Exception ex)
            {
                return "(Unable to read log file: " + ex.Message + ")";
            }
        }

        private string BuildDiagnosticReport()
        {
            config = LoadConfig();
            ServiceControllerStatus? svcStatus = QueryServiceStatus();
            string healthJson;
            bool healthy = CheckHttpHealth(out healthJson);

            StringBuilder sb = new StringBuilder();
            sb.AppendLine("======================================================================");
            sb.AppendLine("  RingWatch Windows Service & Backend — Troubleshooting Report");
            sb.AppendLine("  Generated       : " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss zzz"));
            sb.AppendLine("  Install Folder  : " + baseDir);
            sb.AppendLine("  Data Folder     : " + config.dataDir);
            sb.AppendLine("  Logs Folder     : " + config.logsDir);
            sb.AppendLine("  Port            : " + config.port);
            sb.AppendLine("  Debug Logging   : " + (config.debugLogging ? "ENABLED" : "OFF"));
            sb.AppendLine("  Windows Service : " + (svcStatus.HasValue ? svcStatus.Value.ToString() : "Not Installed"));
            sb.AppendLine("  HTTP Health     : " + (healthy ? "OK (" + healthJson + ")" : "Unreachable"));
            sb.AppendLine("======================================================================");
            sb.AppendLine();
            sb.AppendLine("--- BACKEND LOGS (ringwatch-backend.log) ---");
            sb.AppendLine(ReadTailFile(Path.Combine(config.logsDir, "ringwatch-backend.log"), 500));
            sb.AppendLine();
            sb.AppendLine("--- WINDOWS SERVICE LOGS (ringwatch-service.log) ---");
            sb.AppendLine(ReadTailFile(Path.Combine(config.logsDir, "ringwatch-service.log"), 300));
            return sb.ToString();
        }

        private void ShowLogViewer()
        {
            if (logViewer != null && !logViewer.IsDisposed)
            {
                logViewer.RefreshLogs(true);
                logViewer.BringToFront();
                logViewer.Activate();
                return;
            }
            logViewer = new LogViewerForm(BuildDiagnosticReport, ExportTroubleshootingLog, OpenLogsFolder);
            logViewer.Show();
        }

        private void ExportTroubleshootingLog()
        {
            try
            {
                SaveFileDialog dlg = new SaveFileDialog();
                dlg.Title = "Save RingWatch Troubleshooting Log";
                dlg.Filter = "Log Files (*.log)|*.log|Text Files (*.txt)|*.txt|All Files (*.*)|*.*";
                dlg.InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                dlg.FileName = string.Format("ringwatch-troubleshooting-{0}.log", DateTime.Now.ToString("yyyyMMdd-HHmmss"));
                if (dlg.ShowDialog() == DialogResult.OK)
                {
                    File.WriteAllText(dlg.FileName, BuildDiagnosticReport(), Encoding.UTF8);
                    trayIcon.ShowBalloonTip(3500, "Troubleshooting Log Saved", "Saved to " + dlg.FileName, ToolTipIcon.Info);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("Failed to export troubleshooting log: " + ex.Message, "RingWatch", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void ToggleDebugLogging()
        {
            bool next = !config.debugLogging;
            try
            {
                SaveDebugSetting(next);
                debugItem.Checked = next;
                DialogResult res = MessageBox.Show(
                    string.Format("Verbose debug logging is now {0}.\n\nRestart the RingWatch Backend Service now to apply?",
                        next ? "ENABLED" : "DISABLED"),
                    "RingWatch Debug Logging",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question);
                if (res == DialogResult.Yes)
                {
                    RunServiceAction("restart");
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("Could not update debug setting (try running as Administrator): " + ex.Message,
                    "RingWatch", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void RunServiceInstaller()
        {
            try
            {
                string batPath = Path.Combine(baseDir, "install-windows-service.bat");
                if (!File.Exists(batPath))
                {
                    MessageBox.Show("install-windows-service.bat was not found in " + baseDir,
                        "RingWatch", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
                ProcessStartInfo psi = new ProcessStartInfo(batPath);
                psi.WorkingDirectory = baseDir;
                psi.Verb = "runas";
                psi.UseShellExecute = true;
                Process.Start(psi);
            }
            catch { }
        }

        private void ExitTray()
        {
            pollTimer.Stop();
            trayIcon.Visible = false;
            trayIcon.Dispose();
            if (logViewer != null && !logViewer.IsDisposed)
            {
                logViewer.Close();
            }
            Application.Exit();
        }
    }

    public static class Program
    {
        [STAThread]
        public static void Main()
        {
            bool createdNew;
            using (Mutex mutex = new Mutex(true, "RingWatchTray_SingleInstance_Mutex", out createdNew))
            {
                if (!createdNew)
                {
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new RingWatchTrayContext());
            }
        }
    }
}
