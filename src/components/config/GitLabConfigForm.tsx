import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { gitlabApi } from "@/lib/api";
import type { GitLabConfig } from "@/types/config";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { toast } from "sonner";
import { Activity, ExternalLink, KeyRound, PlugZap, Unplug, X } from "lucide-react";
import { SiGitlab } from "react-icons/si";
import {
  SettingsCard,
  SectionTitle,
  SwitchRow,
  CardDivider,
  CardSection,
} from "./settings-ui";

interface GitLabConfigFormProps {
  config: GitLabConfig;
  setConfig: React.Dispatch<React.SetStateAction<GitLabConfig>>;
  onAutoSave?: (gitlabConfig: GitLabConfig) => Promise<void>;
  /**
   * Removes the stored GitLab source outright. Separate from a normal save
   * because an empty token there means "keep the stored one" — without this
   * there is no way to drop a leaked credential.
   */
  onDisconnect?: () => Promise<void>;
  isAutoSaving?: boolean;
}

export const DEFAULT_GITLAB_CONFIG: GitLabConfig = {
  url: "https://gitlab.com",
  token: "",
  username: "",
  groups: [],
  includeSubgroups: true,
  includeOwnProjects: false,
  includeForks: true,
  includeArchived: false,
  includePrivate: true,
  includePublic: true,
};

export function GitLabConfigForm({
  config,
  setConfig,
  onAutoSave,
  onDisconnect,
  isAutoSaving,
}: GitLabConfigFormProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [newGroup, setNewGroup] = useState("");

  // Only offer disconnect once something is actually stored.
  const isConfigured = Boolean(config.token?.trim());

  const disconnect = async () => {
    if (!onDisconnect) return;
    setIsDisconnecting(true);
    try {
      await onDisconnect();
      setConfig(DEFAULT_GITLAB_CONFIG);
      toast.success("GitLab connection removed.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to remove the connection",
      );
    } finally {
      setIsDisconnecting(false);
    }
  };

  const update = (next: GitLabConfig) => {
    setConfig(next);
    if (onAutoSave) onAutoSave(next);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    update({ ...config, [name]: type === "checkbox" ? checked : value });
  };

  const groups = config.groups ?? [];

  const addGroup = () => {
    // Paths are stored without surrounding slashes so "/acme/platform/" and
    // "acme/platform" are the same group.
    const trimmed = newGroup.trim().replace(/^\/+|\/+$/g, "");
    if (!trimmed) return;
    const exists = groups.some((g) => g.toLowerCase() === trimmed.toLowerCase());
    if (!exists) {
      update({ ...config, groups: [...groups, trimmed] });
    }
    setNewGroup("");
  };

  const removeGroup = (name: string) => {
    update({
      ...config,
      groups: groups.filter((g) => g.toLowerCase() !== name.toLowerCase()),
    });
  };

  const testConnection = async () => {
    if (!config.token) {
      toast.error("GitLab token is required to test the connection");
      return;
    }

    setIsLoading(true);
    try {
      const result = await gitlabApi.testConnection(
        config.url || "https://gitlab.com",
        config.token,
      );
      if (result.success) {
        toast.success(result.message ?? "Successfully connected to GitLab!");
      } else {
        toast.error(result.message ?? "Failed to connect to GitLab.");
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "An unknown error occurred",
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <SettingsCard
      icon={SiGitlab}
      title="GitLab Connection"
      headerAction={
        <div className="flex items-center gap-3">
          {isAutoSaving && (
            <Activity className="h-4 w-4 animate-spin text-muted-foreground" />
          )}
          {isConfigured && onDisconnect && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={disconnect}
              disabled={isDisconnecting}
              className="text-destructive hover:text-destructive"
            >
              <Unplug className="mr-1.5 h-3.5 w-3.5" />
              {isDisconnecting ? "Removing..." : "Disconnect"}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={testConnection}
            disabled={isLoading || !config.token}
          >
            <PlugZap className="mr-1.5 h-3.5 w-3.5" />
            {isLoading ? "Testing..." : "Test"}
          </Button>
        </div>
      }
    >
      <CardSection>
        <div className="space-y-1.5">
          <Label
            htmlFor="gitlab-url"
            className="text-xs font-medium text-muted-foreground"
          >
            Instance URL
          </Label>
          <Input
            id="gitlab-url"
            name="url"
            type="text"
            value={config.url}
            onChange={handleChange}
            placeholder="https://gitlab.com"
          />
          <p className="text-[11px] text-muted-foreground/80">
            Use your own address for a self-hosted GitLab
          </p>
        </div>

        <div className="space-y-1.5">
          <Label
            htmlFor="gitlab-token"
            className="text-xs font-medium text-muted-foreground"
          >
            Personal access token
          </Label>
          <Input
            id="gitlab-token"
            name="token"
            type="password"
            value={config.token}
            onChange={handleChange}
            placeholder="glpat-..."
          />
          <p className="text-[11px] text-muted-foreground/80">
            Used to list projects and to let Gitea pull private repositories
          </p>
        </div>

        <div className="space-y-3 rounded-lg bg-muted/40 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              <span className="text-[13px] font-semibold text-muted-foreground">
                Creating your token
              </span>
            </div>
            <a
              href="https://gitlab.com/-/user_settings/personal_access_tokens"
              target="_blank"
              rel="noopener noreferrer"
              title="Open GitLab personal access tokens"
              aria-label="Open GitLab token settings"
              className="text-indigo-500 hover:text-indigo-400"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          </div>
          <ol className="list-decimal space-y-1.5 pl-4 text-xs leading-relaxed text-muted-foreground">
            <li>GitLab → Preferences → Access tokens</li>
            <li>Add new token, then select the scopes below</li>
            <li>Paste the token here</li>
          </ol>
          <div className="flex items-center gap-2">
            <code className="rounded bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
              read_api
            </code>
            <code className="rounded bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
              read_repository
            </code>
          </div>
        </div>
      </CardSection>

      <CardDivider />

      <CardSection>
        <SectionTitle>Groups to mirror</SectionTitle>

        {groups.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {groups.map((group) => (
              <Badge key={group} variant="secondary" className="gap-1">
                <span>{group}</span>
                <button
                  type="button"
                  onClick={() => removeGroup(group)}
                  className="rounded-sm hover:text-foreground/80"
                  aria-label={`Remove ${group} group`}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Input
            value={newGroup}
            onChange={(event) => setNewGroup(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addGroup();
              }
            }}
            placeholder="acme or acme/platform"
            className="h-8 text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            onClick={addGroup}
            disabled={!newGroup.trim()}
          >
            Add
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground/80">
          Gitea has no nested organizations, so a subgroup like{" "}
          <code className="font-mono">acme/platform</code> is mirrored into an
          organization named <code className="font-mono">acme-platform</code>.
        </p>

        <SwitchRow
          label="Include subgroups"
          description="Also mirror projects from groups nested inside the ones above"
          checked={config.includeSubgroups}
          onCheckedChange={(checked) =>
            update({ ...config, includeSubgroups: checked })
          }
        />

        <SwitchRow
          label="Include my own projects"
          description="Mirror projects in your personal namespace as well"
          checked={config.includeOwnProjects}
          onCheckedChange={(checked) =>
            update({ ...config, includeOwnProjects: checked })
          }
        />
      </CardSection>

      <CardDivider />

      <CardSection>
        <SectionTitle>Which projects</SectionTitle>

        <SwitchRow
          label="Private projects"
          description="Includes internal projects, which are mirrored as private"
          checked={config.includePrivate}
          onCheckedChange={(checked) =>
            update({ ...config, includePrivate: checked })
          }
        />

        <SwitchRow
          label="Public projects"
          checked={config.includePublic}
          onCheckedChange={(checked) =>
            update({ ...config, includePublic: checked })
          }
        />

        <SwitchRow
          label="Forks"
          checked={config.includeForks}
          onCheckedChange={(checked) =>
            update({ ...config, includeForks: checked })
          }
        />

        <SwitchRow
          label="Archived projects"
          checked={config.includeArchived}
          onCheckedChange={(checked) =>
            update({ ...config, includeArchived: checked })
          }
        />
      </CardSection>
    </SettingsCard>
  );
}
