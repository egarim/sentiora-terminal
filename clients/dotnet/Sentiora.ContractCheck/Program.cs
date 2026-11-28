// Contract check for the Sentiora .NET client: it exercises the real runtime (src/server.js)
// over the real subprocess transport and a real PTY. This is the executable half of M3 and
// the thing Creatura.Worlds.Terminal (creatura#102) can run before trusting the adapter.
//
// Usage:
//   dotnet run --project clients/dotnet/Sentiora.ContractCheck -- <repo-root>
//
// Exit code 0 = every check passed. It intentionally has no test-framework dependency so it
// restores and runs offline; a later xUnit wrapper can call the same client.
using System.Diagnostics;
using System.Text.Json;
using Sentiora.Client;

var repoRoot = args.Length > 0 ? Path.GetFullPath(args[0]) : Directory.GetCurrentDirectory();
var server = Path.Combine(repoRoot, "src", "server.js");
var fixture = Path.Combine(repoRoot, "test", "fixtures", "interactive.mjs");
if (!File.Exists(server) || !File.Exists(fixture))
{
    Console.Error.WriteLine($"usage: dotnet run --project clients/dotnet/Sentiora.ContractCheck -- <repo-root>");
    Console.Error.WriteLine($"  expected {server} and {fixture}");
    return 2;
}

var nodeExecutable = ResolveNode();
var failures = 0;
void Pass(string name) => Console.WriteLine($"PASS {name}");
void Fail(string name, Exception error) { failures += 1; Console.WriteLine($"FAIL {name}: {error.Message}"); }

using var cancellation = new CancellationTokenSource(TimeSpan.FromMinutes(2));
var clock = Stopwatch.StartNew();
await using var client = await SentioraClient.StartAsync(server, workingDirectory: repoRoot, cancellationToken: cancellation.Token);
Console.WriteLine($"runtime: {client.Info!.Platform}/{client.Info.Arch} protocol={client.Info.ProtocolVersion} stream={client.Info.Stream} recording={client.Info.Recording}");

SessionHandle? session = null;
try
{
    session = await client.CreateAsync(new CreateSessionRequest
    {
        Command = nodeExecutable,
        Args = new[] { fixture },
        Cols = 60,
        Rows = 16,
    }, cancellation.Token);
    if (session.Pid is > 0) Pass($"create returns a real child pid ({session.Pid})");
    else Fail("create returns a real child pid", new Exception($"pid was {session.Pid}"));

    var ready = await client.WaitForTextAsync(session, "FIXTURE READY", cancellationToken: cancellation.Token);
    Pass($"first bytes are readable through terminal.stream ({ready.Text.Length} chars)");

    var revision = await client.SendLineAsync(session, "echo hello", cancellation.Token);
    Pass($"type is revision-armed and accepted (revision {revision})");

    var echo = await client.WaitForTextAsync(session, "ECHO:hello", afterSequence: ready.NextSequence, cancellationToken: cancellation.Token);
    if (echo.Text.Contains("ECHO:hello", StringComparison.Ordinal)) Pass("command output is observable as bytes");
    else Fail("command output is observable as bytes", new Exception("marker not found"));

    var observation = await client.ObserveAsync(session, cancellation.Token);
    if (observation.Revision > 0 && observation.Running) Pass("observe reports objective state and revision");
    else Fail("observe reports objective state and revision", new Exception($"revision={observation.Revision} running={observation.Running}"));

    if (await client.CloseAsync(session, cancellation.Token)) Pass("close returns true");
    else Fail("close returns true", new Exception("close returned false"));
    session = null;

    var remaining = await client.ListAsync(cancellation.Token);
    if (remaining.Count == 0) Pass("a closed session leaves the registry");
    else Fail("a closed session leaves the registry", new Exception($"{remaining.Count} session(s) left"));
}
catch (Exception error)
{
    Fail("session lifecycle", error);
}
finally
{
    if (session is not null)
    {
        try { await client.CloseAsync(session, cancellation.Token); } catch { /* best effort */ }
    }
}

// Process exit is its own fact: the World adapter must see it without polling the screen.
try
{
    var exiting = await client.CreateAsync(new CreateSessionRequest
    {
        Command = nodeExecutable,
        Args = new[] { "-e", "setTimeout(() => process.exit(7), 150)" },
        Cols = 40,
        Rows = 12,
    }, cancellation.Token);
    var frame = await client.WaitForTextAsync(exiting, "never-printed", 20000, cancellationToken: cancellation.Token);
    if (frame.Frame.Exit?.ExitCode == 7) Pass("child exit code is observable through the stream (7)");
    else Fail("child exit code is observable through the stream", new Exception($"exit={frame.Frame.Exit?.ExitCode}"));
    await client.CloseAsync(exiting, cancellation.Token);
}
catch (Exception error)
{
    Fail("child exit code is observable through the stream", error);
}

// A failed spawn must be an error, not a session with no child. Windows-specific: on POSIX a
// bad cwd is deferred to the forked child, so the create succeeds.
if (OperatingSystem.IsWindows() && Environment.GetEnvironmentVariable("SENTIORA_SKIP_FAILED_SPAWN") != "1")
{
    try
    {
        var bogus = await client.CreateAsync(new CreateSessionRequest
        {
            Command = nodeExecutable,
            Args = new[] { fixture },
            Cwd = "Z:/definitely/not/here",
        }, cancellation.Token);
        await client.CloseAsync(bogus, cancellation.Token);
        Fail("a failed spawn is an error", new Exception("create succeeded with a bad cwd"));
    }
    catch (SentioraException error)
    {
        if (error.Message.Contains("Invalid cwd", StringComparison.OrdinalIgnoreCase)
            || error.Message.Contains("Cannot create process", StringComparison.OrdinalIgnoreCase)
            || error.Message.Contains("Session failed to start", StringComparison.OrdinalIgnoreCase))
        {
            Pass("a failed spawn is an error");
        }
        else
        {
            Fail("a failed spawn is an error", error);
        }
    }
    catch (Exception error)
    {
        Fail("a failed spawn is an error", error);
    }
}

// The mailbox (issue #34): a message channel that is deliberately not the PTY, authorised by a
// capability that is deliberately not the owner token.
{
    var mailboxSession = await client.CreateAsync(new CreateSessionRequest
    {
        Command = nodeExecutable,
        Args = new[] { fixture },
        Cols = 60,
        Rows = 16,
    }, cancellation.Token);
    try
    {
        if (string.IsNullOrEmpty(mailboxSession.Mailbox))
            Fail("create returns a mailbox capability", new Exception("no mailbox capability on the handle"));
        else
            Pass("create returns a mailbox capability");

        if (mailboxSession.Mailbox == mailboxSession.Owner)
            Fail("the mailbox capability is not the owner token", new Exception("the two tokens are equal"));
        else
            Pass("the mailbox capability is not the owner token");

        var posted = await client.PostAsync(mailboxSession, new { kind = "task", text = "run" }, cancellation.Token);
        if (posted.Sequence == 1)
            Pass("a message is posted and sequenced");
        else
            Fail("a message is posted and sequenced", new Exception($"sequence was {posted.Sequence}"));

        var frame = await client.MailboxAsync(mailboxSession, 0, 1000, cancellation.Token);
        var text = frame.Messages.Count == 1 ? frame.Messages[0].Payload.GetProperty("text").GetString() : null;
        if (text == "run")
            Pass("the mailbox returns the posted message");
        else
            Fail("the mailbox returns the posted message",
                new Exception($"{frame.Messages.Count} message(s); frame={JsonSerializer.Serialize(frame)}"));
    }
    finally
    {
        await client.CloseAsync(mailboxSession, cancellation.Token);
    }
}

// Cooperative handover (issue #4): the old token must die at the same moment the new one is issued,
// and a refused handover must rotate nothing.
{
    var original = await client.CreateAsync(new CreateSessionRequest
    {
        Command = nodeExecutable,
        Args = new[] { fixture },
        Cols = 60,
        Rows = 16,
    }, cancellation.Token);
    var handed = await client.HandoverAsync(original, cancellation.Token);

    if (handed.SessionId == original.SessionId && handed.Owner != original.Owner)
        Pass("handover issues a new owner token for the same session");
    else
        Fail("handover issues a new owner token for the same session",
            new Exception($"sameSession={handed.SessionId == original.SessionId} sameOwner={handed.Owner == original.Owner}"));

    try
    {
        await client.CloseAsync(original, cancellation.Token);
        Fail("the old token is refused after a handover", new Exception("close succeeded with the stale token"));
    }
    catch (SentioraException)
    {
        Pass("the old token is refused after a handover");
    }

    if (await client.CloseAsync(handed, cancellation.Token))
        Pass("the new owner can close the session");
    else
        Fail("the new owner can close the session", new Exception("close returned false"));
}

var disposeClock = Stopwatch.StartNew();
await client.DisposeAsync();
Console.WriteLine($"host shutdown: {disposeClock.ElapsedMilliseconds}ms forced={client.ForcedShutdown} (stderr {client.Stderr.Length} bytes)");
// The measurement above used to be printed and never judged, so this check reported PASSED while
// the host had to be SIGKILLed. A host that needs forcing is a host that cannot exit, which is the
// whole contract: it must go when its stdin closes.
if (client.ForcedShutdown)
    Fail("the host shuts down on its own", new Exception($"the host had to be killed after {disposeClock.ElapsedMilliseconds}ms"));
else
    Pass("the host shuts down on its own");
Console.WriteLine(failures == 0
    ? $"CONTRACT CHECK PASSED in {clock.ElapsedMilliseconds}ms"
    : $"CONTRACT CHECK FAILED: {failures} check(s)");
return failures == 0 ? 0 : 1;

// node-pty reports a relative command it cannot resolve as "File not found: " with an
// empty name, which is not actionable. Resolve the interpreter here so the contract
// check uses the same absolute path the JS tests use.
static string ResolveNode()
{
    var name = OperatingSystem.IsWindows() ? "node.exe" : "node";
    foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
    {
        if (string.IsNullOrWhiteSpace(directory)) continue;
        var candidate = Path.Combine(directory, name);
        if (File.Exists(candidate)) return candidate;
    }
    return name;
}
