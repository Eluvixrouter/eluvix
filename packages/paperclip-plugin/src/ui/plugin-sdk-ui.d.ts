declare module '@paperclipai/plugin-sdk/ui' {
  import type { AnchorHTMLAttributes, MouseEvent as ReactMouseEvent } from 'react';

  export interface PluginBridgeError {
    code: string;
    message: string;
    details?: unknown;
  }

  export interface PluginHostContext {
    companyId: string | null;
    companyPrefix: string | null;
    projectId: string | null;
    entityId: string | null;
    entityType: string | null;
    parentEntityId?: string | null;
    userId: string | null;
  }

  export interface PluginDataResult<T = unknown> {
    data: T | null;
    loading: boolean;
    error: PluginBridgeError | null;
    refresh: () => void;
  }

  export type PluginActionFn = <TResult = unknown>(
    params?: Record<string, unknown>
  ) => Promise<TResult>;

  export interface HostNavigationLinkProps
    extends Pick<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'target' | 'rel'> {
    onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
  }

  export interface HostNavigation {
    resolveCompanyPath?(path: string): string;
    navigate(to: string, options?: { replace?: boolean; state?: unknown }): void;
    linkProps?(
      to: string,
      options?: {
        replace?: boolean;
        state?: unknown;
        target?: AnchorHTMLAttributes<HTMLAnchorElement>['target'];
        rel?: AnchorHTMLAttributes<HTMLAnchorElement>['rel'];
      }
    ): HostNavigationLinkProps;
  }

  export type PluginToastFn = (toast: {
    title: string;
    description?: string;
    tone?: 'info' | 'success' | 'warning' | 'error';
  }) => void;

  export interface PluginWidgetProps {
    context: PluginHostContext;
  }

  export interface PluginPageProps {
    context: PluginHostContext;
  }

  export interface PluginSidebarProps {
    context: PluginHostContext;
  }

  export interface PluginDetailTabProps {
    context: PluginHostContext & {
      entityId: string;
      entityType: string;
    };
  }

  export function usePluginData<T = unknown>(
    key: string,
    params?: Record<string, unknown>
  ): PluginDataResult<T>;
  export function usePluginAction(key: string): PluginActionFn;
  export function useHostContext(): PluginHostContext;
  export function useHostNavigation(): HostNavigation;
  export function usePluginToast(): PluginToastFn;
}
