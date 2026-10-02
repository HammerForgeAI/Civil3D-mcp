using System.Text.Json.Nodes;

namespace Civil3DMcpPlugin;

/// <summary>
/// P11: the plugin half of the approval gate for the two escape hatches
/// (send_command and execute_script). The TypeScript approval policy is the
/// authority — it classifies both actions as mutating and issues a single-use
/// token bound to the exact parameters — and these methods refuse to run
/// anything without a token, so neither escape hatch has an ungated plugin path.
///
/// The token cannot be verified here (it lives in the MCP server's memory), so
/// this is a deliberate second lock, not the lock itself: it also rejects a
/// reused token, which makes a replayed call fail even inside Civil 3D.
/// </summary>
internal static class ApprovalTokenGuard
{
  private const int MaxRememberedTokens = 4096;
  private static readonly object Sync = new();
  private static readonly Dictionary<string, long> ConsumedTokens = new(StringComparer.Ordinal);
  private static readonly Queue<string> ConsumedOrder = new();

  internal static void Require(JsonObject? parameters, string operation)
  {
    var token = PluginRuntime.GetOptionalString(parameters, "approvalToken");
    if (string.IsNullOrWhiteSpace(token))
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.FORBIDDEN",
        $"'{operation}' requires an approval token and is never run ungated. Call civil3d_request_approval for this tool, action and parameters, then retry with approvalToken.");
    }

    if (!Guid.TryParse(token, out _))
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.FORBIDDEN",
        $"'{operation}' received an approval token that is not a token issued by civil3d_request_approval.");
    }

    lock (Sync)
    {
      if (ConsumedTokens.ContainsKey(token))
      {
        throw new JsonRpcDispatchException(
          "CIVIL3D.FORBIDDEN",
          $"'{operation}' received an approval token that has already been used. Request a new approval.");
      }

      ConsumedTokens[token] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
      ConsumedOrder.Enqueue(token);
      while (ConsumedOrder.Count > MaxRememberedTokens)
      {
        ConsumedTokens.Remove(ConsumedOrder.Dequeue());
      }
    }
  }
}
