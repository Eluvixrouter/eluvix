import { NextResponse } from 'next/server';
import { orchestratorManager, DeploymentTier } from '@/lib/orchestration/manager';
import { reloadConfig } from '@/lib/router';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    
    // Normalize target tier (default to k3d, or compose/local)
    const tier: DeploymentTier = body.tier || 'k3d';

    // Normalize compiled configs (can be passed at root or in body.compiledConfigs)
    const compiledConfigs = body.compiledConfigs || {
      eluvixJson: body.eluvixJson,
      bifrostYaml: body.bifrostYaml,
      agentRouterJson: body.agentRouterJson,
      agentGatewayJson: body.agentGatewayJson,
      privacyGuardSetup: body.privacyGuardSetup,
      semanticRouterSetup: body.semanticRouterSetup,
      observabilitySetup: body.observabilitySetup,
      antigravityConfig: body.antigravityConfig,
      codexConfig: body.codexConfig,
      claudeCodeConfig: body.claudeCodeConfig,
      rawRouterConfig: body.rawRouterConfig
    };

    const result = await orchestratorManager.deploy({
      tier,
      compiledConfigs
    });

    if (tier === 'local' && result.success) {
      try {
        reloadConfig();
        result.logs.push('✓ Reloaded active in-memory Next.js Switchyard router configuration.');
      } catch {}
    }

    return NextResponse.json({
      success: result.success,
      tier: result.tier,
      message: result.message,
      logs: result.logs,
      durationMs: result.durationMs
    });
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      error: error.message || 'Deployment failed',
      logs: [error.message]
    }, { status: 500 });
  }
}
