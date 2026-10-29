import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  calculateEcmpHashPolarization,
  encodeAndSimulateSrv6Usid,
  planDeterministicSrv6SpineSchedule,
  simulateOooDdpBitmapWindow,
  simulateAiClusterFabric,
  generateFrrBgpUnnumberedConfig,
  generateHostFabricTuningScript,
  isCollisionFreeRailFabricUpstream,
  isLegacyEcmpFabricUpstream,
  Eluvix,
  type UpstreamConfig
} from '../index.js';

describe('Rail-Optimized Leaf-Spine Clos Fabric: BGP EVPN, SRv6 uSID & DLB OOO-DDP', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Balls-into-Bins ECMP Hash Polarization Combinatorics', () => {
    it('computes exact P(zero collision) = 0.24% and E[Idle Uplinks] = 34.36% for K=8 spines and M=8 elephant flows', () => {
      const stats = calculateEcmpHashPolarization(8, 8);
      // 8! / 8^8 = 40320 / 16777216 = 0.002403259...
      expect(stats.zeroCollisionProbability).toBeCloseTo(0.002403, 5);
      expect(stats.collisionProbabilityPct).toBeCloseTo(99.76, 2);
      // (7/8)^8 = 0.3436089...
      expect(stats.expectedIdleUplinksPct).toBeCloseTo(34.36, 2);
      expect(stats.effectiveStaticEcmpUtilizationPct).toBe(44.6);
    });

    it('returns 0 zero-collision probability when M > K (pigeonhole principle)', () => {
      const stats = calculateEcmpHashPolarization(8, 16);
      expect(stats.zeroCollisionProbability).toBe(0);
      expect(stats.collisionProbabilityPct).toBe(100);
    });
  });

  describe('128-Bit SRv6 Micro-SID (uSID, RFC 8986) Carrier & 8ns Hardware Shift', () => {
    it('encodes fcbb:bb00:0202:0104:0040:: with 0-byte SRH overhead and shifts left by 16 bits at the Spine ASIC', () => {
      const sim = encodeAndSimulateSrv6Usid({
        blockPrefix: 'fcbb:bb00',
        spineUsid: '0202',
        egressLeafUsid: '0104',
        dt4VrfUsid: '0040'
      });

      expect(sim.carrierAddress).toBe('fcbb:bb00:0202:0104:0040::');
      expect(sim.srhOverheadBytes).toBe(0);
      expect(sim.legacySrv6SrhOverheadBytes).toBe(56);
      expect(sim.hops).toHaveLength(3);

      // Hop 0: Source Host / Ingress Leaf (H.Encaps.Red)
      expect(sim.hops[0].stage).toBe('H.Encaps.Red');
      expect(sim.hops[0].ipv6DestinationAddress).toBe('fcbb:bb00:0202:0104:0040::');
      expect(sim.hops[0].srhExtensionHeaderBytes).toBe(0);

      // Hop 1: Spine Transit ASIC (End.uN 8ns 16-bit left shift)
      expect(sim.hops[1].stage).toBe('End.uN');
      expect(sim.hops[1].forwardingLatencyNs).toBe(8);
      expect(sim.hops[1].ipv6DestinationAddress).toBe('fcbb:bb00:0104:0040::');

      // Hop 2: Egress Leaf VRF Decap (End.uDT4)
      expect(sim.hops[2].stage).toBe('End.uDT4');
      expect(sim.hops[2].ipv6DestinationAddress).toBe('fcbb:bb00:0040::');
    });

    it('plans a collision-free disjoint Spine uSID schedule across 8 concurrent flows', () => {
      const schedule = planDeterministicSrv6SpineSchedule(8, 8, 2, 4);
      expect(schedule).toHaveLength(8);
      const uniqueSpines = new Set(schedule.map((s) => s.spineUsid));
      expect(uniqueSpines.size).toBe(8);
      expect(schedule[1].carrierIpv6Address).toBe('fcbb:bb00:0202:0204:0040::');
    });
  });

  describe('ConnectX-7/8 Out-of-Order Direct Data Placement (OOO-DDP) PSN Bitmap', () => {
    it('places out-of-order sprayed packets directly into GPU HBM3e offsets with zero Go-Back-N retransmissions', () => {
      const ooo = simulateOooDdpBitmapWindow([100, 104, 102, 101, 105, 103, 107, 106], 0x100000, 4096);
      expect(ooo.totalPackets).toBe(8);
      expect(ooo.outOfOrderCount).toBeGreaterThan(0);
      expect(ooo.legacyInOrderGoBackNRetransmits).toBeGreaterThan(0);
      expect(ooo.oooDdpRetransmits).toBe(0);
      expect(ooo.wqeCompletedZeroCopy).toBe(true);

      // Packet PSN 104 (second to arrive) lands at exact offset 0x100000 + 4 * 4096
      const psn104 = ooo.placements.find((p) => p.psn === 104)!;
      expect(psn104.wasOutOfOrder).toBe(true);
      expect(psn104.targetHbmByteOffset).toBe(0x100000 + 4 * 4096);
      expect(ooo.placements[ooo.placements.length - 1].contiguousDeliveredUpToPsn).toBe(107);
    });
  });

  describe('4-Architecture Cluster Benchmark & SONiC FRRouting / Host Script Generation', () => {
    it('models 2.69x MoE AllToAll bus bandwidth speedup (168 -> 452 GB/s) and generates RFC 8950 BGP Unnumbered configs', () => {
      const sim = simulateAiClusterFabric({
        spineUplinksK: 8,
        concurrentFlowsM: 8,
        linkSpeedGbps: 400,
        enableNcclPxn: true,
        enableSrv6Usid: true,
        enableDlbOooDdp: true
      });

      expect(sim.activeArchitectureId).toBe('rail-dlb-oooddp');
      expect(sim.moeAllToAllSpeedupRatio).toBe(2.69);

      const dlbBench = sim.benchmarks.find((b) => b.id === 'rail-dlb-oooddp')!;
      expect(dlbBench.allReduceBusBwGBps).toBe(469);
      expect(dlbBench.allToAllMoeBusBwGBps).toBe(452);
      expect(dlbBench.effectiveLinkUtilizationPct).toBe(97.8);

      const frr = generateFrrBgpUnnumberedConfig({ railIndex: 0, leafIndex: 1 });
      expect(frr).toContain('neighbor SPINE_FABRIC capability extended-nexthop');
      expect(frr).toContain('address-family l2vpn evpn');
      expect(frr).toContain('prefix fcbb:bb00:0101::/48 block-len 32 node-len 16 func-bits 16');

      const hostScript = generateHostFabricTuningScript();
      expect(hostScript).toContain('export NCCL_PXN_DISABLE=0');
      expect(hostScript).toContain('encap seg6 mode encap.red');
      expect(hostScript).toContain('OO_RECV_WR_EN=1');
    });
  });

  describe('Fabric-Aware Switchyard Routing & Telemetry Headers', () => {
    const legacyTorUpstream: UpstreamConfig = {
      id: 'tor-ecmp-worker',
      name: 'Legacy ToR Static ECMP Worker',
      type: 'sglang',
      endpoint: 'http://127.0.0.1:30001',
      priority: 40,
      models: ['deepseek-ai/DeepSeek-V3'],
      fabric: {
        enabled: true,
        topology: 'tor-static-ecmp'
      }
    };

    const railSrv6Upstream: UpstreamConfig = {
      id: 'rail-srv6-worker',
      name: 'Rail-Optimized SRv6 uSID Worker',
      type: 'vllm',
      endpoint: 'http://127.0.0.1:30002',
      priority: 25,
      models: ['deepseek-ai/DeepSeek-V3'],
      fabric: {
        enabled: true,
        topology: 'rail-srv6-usid',
        ncclPxn: true,
        srv6UsidCarrier: 'fcbb:bb00:0202:0104:0040::'
      }
    };

    const railDlbUpstream: UpstreamConfig = {
      id: 'rail-dlb-worker',
      name: 'Rail-Optimized DLB + ConnectX-8 OOO-DDP Worker',
      type: 'sglang',
      endpoint: 'http://127.0.0.1:30003',
      priority: 20,
      models: ['deepseek-ai/DeepSeek-V3'],
      fabric: {
        enabled: true,
        topology: 'rail-dlb-oooddp',
        ncclPxn: true,
        dlbPacketSpraying: true,
        oooDdpEnabled: true
      }
    };

    it('correctly classifies collision-free Rail-Optimized upstreams vs legacy static ECMP upstreams', () => {
      expect(isLegacyEcmpFabricUpstream(legacyTorUpstream)).toBe(true);
      expect(isCollisionFreeRailFabricUpstream(legacyTorUpstream)).toBe(false);
      expect(isCollisionFreeRailFabricUpstream(railSrv6Upstream)).toBe(true);
      expect(isCollisionFreeRailFabricUpstream(railDlbUpstream)).toBe(true);
    });

    it('excludes legacy ToR static ECMP upstreams and prioritizes DLB+OOO-DDP under require-collision-free-fabric', () => {
      const router = new Eluvix({
        upstreams: [legacyTorUpstream, railSrv6Upstream, railDlbUpstream],
        switchyard: {
          strategy: 'priority',
          fabricPolicy: 'require-collision-free-fabric'
        }
      });

      const explanation = router.explainRoute({
        model: 'deepseek-ai/DeepSeek-V3',
        messages: [{ role: 'user', content: 'Run distributed MoE AllToAll inference step' }]
      });

      expect(explanation.chosenUpstreamId).toBe('rail-dlb-worker');
      expect(explanation.rankedUpstreams.map((u) => u.id)).toEqual([
        'rail-dlb-worker',
        'rail-srv6-worker'
      ]);
      const fabricSteps = explanation.steps.filter((s) => s.stage === 'clos-fabric-routing');
      expect(fabricSteps.length).toBeGreaterThanOrEqual(1);
      expect(fabricSteps[0].removed).toContain('tor-ecmp-worker');
    });

    it('emits x-eluvix-fabric-topology, x-eluvix-rdma-transport, and x-eluvix-srv6-usid-carrier headers', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'chatcmpl-srv6-1',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'SRv6 uSID routed' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 16, completion_tokens: 8, total_tokens: 24 }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const router = new Eluvix({
        upstreams: [railSrv6Upstream],
        switchyard: {
          fabricPolicy: 'prefer-rail-optimized'
        }
      });

      const res = await router.routeChatCompletion({
        model: 'deepseek-ai/DeepSeek-V3',
        messages: [{ role: 'user', content: 'Verify SRv6 uSID carrier header' }]
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('x-eluvix-fabric-topology')).toBe('rail-srv6-usid');
      expect(res.headers.get('x-eluvix-rdma-transport')).toBe('rocev2-srv6-usid');
      expect(res.headers.get('x-eluvix-srv6-usid-carrier')).toBe('fcbb:bb00:0202:0104:0040::');
    });
  });
});
