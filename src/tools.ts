import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DocmostClient } from "./client.js";
import { DocmostError, VersionError } from "./errors.js";
import {
  asItems,
  errorResult,
  exportFileName,
  normalizeLabel,
  pageSummary,
  proseMirrorToMarkdown,
  slugify,
  textResult,
  type Json,
} from "./util.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const pageId = z.string().min(1).describe("Page UUID or slugId");
const spaceId = z.string().min(1).describe("Space UUID or slug");
const limit = z.number().int().min(1).max(100).optional().describe("Page size, 1-100");
const cursor = z.string().optional().describe("Pagination cursor from meta.nextCursor");

type ToolKind = "read" | "write" | "destructive";

function hints(kind: ToolKind) {
  return {
    readOnlyHint: kind === "read",
    destructiveHint: kind === "destructive",
    openWorldHint: true,
  };
}

function wrap(
  client: DocmostClient,
  kind: ToolKind,
  fn: (args: Record<string, unknown>) => Promise<unknown>,
) {
  return async (args: Record<string, unknown>) => {
    try {
      if (kind !== "read") {
        client.assertMutable();
      }
      return textResult(await fn(args));
    } catch (error) {
      return errorResult(error);
    }
  };
}

export function registerTools(server: McpServer, client: DocmostClient): void {
  registerPageTools(server, client);
  registerSpaceTools(server, client);
  registerCommentTools(server, client);
  registerSearchTools(server, client);
  registerWorkspaceTools(server, client);
  registerAttachmentTools(server, client);
  registerLabelTools(server, client);
  registerMemberTools(server, client);
}

function registerPageTools(server: McpServer, client: DocmostClient): void {
  server.registerTool(
    "search_pages",
    {
      description: "Full-text search for pages the authenticated user can access. Optionally scope to a space.",
      annotations: hints("read"),
      inputSchema: {
        query: z.string().min(1).describe("Search text"),
        space_id: spaceId.optional(),
        limit,
        offset: z.number().int().min(0).optional().describe("Result offset"),
      },
    },
    wrap(client, "read", async (args) => {
      const spaceIdValue = args.space_id
        ? await client.resolveSpaceId(String(args.space_id))
        : undefined;
      const result = asItems(
        await client.request("/search", {
          query: args.query,
          spaceId: spaceIdValue,
          limit: args.limit,
          offset: args.offset,
        }),
      );
      return {
        items: result.items.map((item) => {
          const page = item as Json;
          return {
            id: page.id,
            slugId: page.slugId,
            title: page.title,
            icon: page.icon,
            spaceId: page.spaceId,
            highlight: page.highlight,
            rank: page.rank,
            space: page.space,
          };
        }),
        meta: result.meta,
      };
    }),
  );

  server.registerTool(
    "get_page",
    {
      description: "Get a page's metadata and Markdown body. Use format=json for raw ProseMirror.",
      annotations: hints("read"),
      inputSchema: {
        page_id: pageId,
        format: z.enum(["markdown", "html", "json"]).optional().describe("Content format. Default markdown"),
      },
    },
    wrap(client, "read", async (args) => {
      const format = (args.format as string | undefined) ?? "markdown";
      const page = (await client.request("/pages/info", {
        pageId: args.page_id,
        format,
      })) as Json;
      return {
        ...pageSummary(page),
        content: page.content,
        creator: page.creator,
        lastUpdatedBy: page.lastUpdatedBy,
      };
    }),
  );

  server.registerTool(
    "create_page",
    {
      description: "Create a page in a space. Body is Markdown and is persisted in place (Docmost v0.71+). Can nest under a parent.",
      annotations: hints("write"),
      inputSchema: {
        space_id: spaceId,
        title: z.string().min(1).describe("Page title"),
        markdown: z.string().optional().describe("Page body as Markdown"),
        parent_page_id: z.string().optional().describe("Parent page UUID to nest under"),
        icon: z.string().optional().describe("Page icon, usually an emoji"),
      },
    },
    wrap(client, "write", async (args) => {
      await client.assertWritable();
      const resolvedSpaceId = await client.resolveSpaceId(String(args.space_id));
      const markdown = args.markdown as string | undefined;
      const created = (await client.request("/pages/create", {
        spaceId: resolvedSpaceId,
        title: args.title,
        parentPageId: args.parent_page_id,
        icon: args.icon,
        ...(markdown
          ? { content: markdown, format: "markdown" }
          : {}),
      })) as Json;

      if (markdown) {
        try {
          await client.confirmMarkdownWrite(created, markdown);
        } catch (error) {
          if (!(error instanceof VersionError) || typeof created.id !== "string") {
            throw error;
          }
          const updated = await client.request("/pages/update", {
            pageId: created.id,
            title: args.title,
            content: markdown,
            format: "markdown",
            operation: "replace",
          });
          await client.confirmMarkdownWrite(updated, markdown);
          return pageSummary(updated);
        }
      }
      return pageSummary(created);
    }),
  );

  server.registerTool(
    "update_page",
    {
      description: "Update a page title, icon, and/or Markdown body in place. Body writes use the server converter (v0.71+). operation defaults to replace.",
      annotations: hints("write"),
      inputSchema: {
        page_id: pageId,
        title: z.string().optional(),
        icon: z.string().optional(),
        markdown: z.string().optional().describe("New Markdown body"),
        operation: z
          .enum(["replace", "append", "prepend"])
          .optional()
          .describe("How to apply markdown. Default replace"),
      },
    },
    wrap(client, "write", async (args) => {
      if (args.markdown) {
        await client.assertWritable();
      }
      const updated = await client.request("/pages/update", {
        pageId: args.page_id,
        title: args.title,
        icon: args.icon,
        ...(args.markdown
          ? {
              content: args.markdown,
              format: "markdown",
              operation: args.operation ?? "replace",
            }
          : {}),
      });
      if (args.markdown) {
        await client.confirmMarkdownWrite(updated, String(args.markdown));
      }
      return pageSummary(updated);
    }),
  );

  server.registerTool(
    "list_pages",
    {
      description:
        "List pages in a space. Default view=recent is recently updated pages (not the sidebar tree; General can look empty). Use view=tree for space-root pages in sidebar order, or list_child_pages for children of a page.",
      annotations: hints("read"),
      inputSchema: {
        space_id: spaceId,
        view: z
          .enum(["recent", "tree"])
          .optional()
          .describe("recent (default) or tree for sidebar-root pages"),
        limit,
        cursor,
      },
    },
    wrap(client, "read", async (args) => {
      const resolvedSpaceId = await client.resolveSpaceId(String(args.space_id));
      const view = (args.view as string | undefined) ?? "recent";
      const result = asItems(
        await client.request(view === "tree" ? "/pages/sidebar-pages" : "/pages/recent", {
          spaceId: resolvedSpaceId,
          limit: args.limit ?? 50,
          cursor: args.cursor,
        }),
      );
      return {
        view,
        items: result.items.map(pageSummary),
        meta: result.meta,
      };
    }),
  );

  server.registerTool(
    "list_child_pages",
    {
      description: "List direct child pages of a page, in sidebar order. Omit page_id and pass space_id for space-root pages.",
      annotations: hints("read"),
      inputSchema: {
        page_id: pageId.optional(),
        space_id: spaceId.optional(),
        limit,
        cursor,
      },
    },
    wrap(client, "read", async (args) => {
      if (!args.page_id && !args.space_id) {
        throw new Error("Provide page_id or space_id");
      }
      const result = asItems(
        await client.request("/pages/sidebar-pages", {
          pageId: args.page_id,
          spaceId: args.space_id
            ? await client.resolveSpaceId(String(args.space_id))
            : undefined,
          limit: args.limit ?? 50,
          cursor: args.cursor,
        }),
      );
      return {
        items: result.items.map(pageSummary),
        meta: result.meta,
      };
    }),
  );

  server.registerTool(
    "duplicate_page",
    {
      description: "Duplicate a page and its accessible sub-pages within the same space.",
      annotations: hints("write"),
      inputSchema: { page_id: pageId },
    },
    wrap(client, "write", async (args) => client.request("/pages/duplicate", { pageId: args.page_id })),
  );

  server.registerTool(
    "copy_page_to_space",
    {
      description: "Copy a page and its accessible sub-pages into a different space.",
      annotations: hints("write"),
      inputSchema: {
        page_id: pageId,
        space_id: spaceId.describe("Destination space"),
      },
    },
    wrap(client, "write", async (args) =>
      client.request("/pages/duplicate", {
        pageId: args.page_id,
        spaceId: await client.resolveSpaceId(String(args.space_id)),
      }),
    ),
  );

  server.registerTool(
    "move_page",
    {
      description: "Move a page under a new parent or to the space root. Position is computed unless you pass an explicit 5-12 character key.",
      annotations: hints("write"),
      inputSchema: {
        page_id: pageId,
        parent_page_id: z
          .string()
          .nullable()
          .optional()
          .describe("New parent page UUID. Null or omitted with root=true moves to space root"),
        root: z.boolean().optional().describe("Move to the space root"),
        position: z
          .enum(["first", "last"])
          .or(z.string().min(5).max(12))
          .optional()
          .describe("first, last, or an explicit fractional index"),
        after_page_id: z.string().optional().describe("Place after this sibling page"),
      },
    },
    wrap(client, "write", async (args) => {
      const parentPageId = args.root ? null : (args.parent_page_id as string | null | undefined);
      const position = await client.computeMovePosition({
        pageId: String(args.page_id),
        parentPageId,
        position: args.position as "first" | "last" | string | undefined,
        afterPageId: args.after_page_id as string | undefined,
      });
      return client.request("/pages/move", {
        pageId: args.page_id,
        parentPageId,
        position,
      });
    }),
  );

  server.registerTool(
    "move_page_to_space",
    {
      description: "Move a page and its accessible sub-pages to a different space.",
      annotations: hints("write"),
      inputSchema: {
        page_id: pageId,
        space_id: spaceId.describe("Destination space"),
      },
    },
    wrap(client, "write", async (args) =>
      client.request("/pages/move-to-space", {
        pageId: args.page_id,
        spaceId: await client.resolveSpaceId(String(args.space_id)),
      }),
    ),
  );

  server.registerTool(
    "delete_page",
    {
      description: "Move a page to trash, or permanently delete it. Permanent delete requires space admin.",
      annotations: hints("destructive"),
      inputSchema: {
        page_id: pageId,
        permanently: z.boolean().optional().describe("If true, permanently delete. Default false (trash)"),
      },
    },
    wrap(client, "destructive", async (args) => {
      await client.request("/pages/delete", {
        pageId: args.page_id,
        permanentlyDelete: Boolean(args.permanently),
      });
      return {
        pageId: args.page_id,
        deleted: true,
        permanent: Boolean(args.permanently),
      };
    }),
  );

  server.registerTool(
    "restore_page",
    {
      description: "Restore a soft-deleted page from trash.",
      annotations: hints("write"),
      inputSchema: { page_id: pageId },
    },
    wrap(client, "write", async (args) => pageSummary(await client.request("/pages/restore", { pageId: args.page_id }))),
  );

  server.registerTool(
    "list_trash",
    {
      description: "List soft-deleted pages in a space.",
      annotations: hints("read"),
      inputSchema: { space_id: spaceId, limit, cursor },
    },
    wrap(client, "read", async (args) => {
      const result = asItems(
        await client.request("/pages/trash", {
          spaceId: await client.resolveSpaceId(String(args.space_id)),
          limit: args.limit ?? 50,
          cursor: args.cursor,
        }),
      );
      return { items: result.items.map(pageSummary), meta: result.meta };
    }),
  );

  server.registerTool(
    "get_page_history",
    {
      description: "List revision history for a page.",
      annotations: hints("read"),
      inputSchema: { page_id: pageId, limit, cursor },
    },
    wrap(client, "read", async (args) =>
      asItems(
        await client.request("/pages/history", {
          pageId: args.page_id,
          limit: args.limit ?? 20,
          cursor: args.cursor,
        }),
      ),
    ),
  );

  server.registerTool(
    "get_history_version",
    {
      description: "Get a specific page history version by history ID.",
      annotations: hints("read"),
      inputSchema: {
        history_id: z.string().uuid().describe("History version UUID"),
      },
    },
    wrap(client, "read", async (args) => client.request("/pages/history/info", { historyId: args.history_id })),
  );

  server.registerTool(
    "get_breadcrumbs",
    {
      description: "Get the ancestor path from space root to a page.",
      annotations: hints("read"),
      inputSchema: { page_id: pageId },
    },
    wrap(client, "read", async (args) => client.request("/pages/breadcrumbs", { pageId: args.page_id })),
  );

  server.registerTool(
    "get_backlinks",
    {
      description: "List incoming or outgoing page links.",
      annotations: hints("read"),
      inputSchema: {
        page_id: pageId,
        direction: z.enum(["incoming", "outgoing"]).describe("incoming or outgoing"),
        limit,
        cursor,
      },
    },
    wrap(client, "read", async (args) =>
      asItems(
        await client.request("/pages/backlinks", {
          pageId: args.page_id,
          direction: args.direction,
          limit: args.limit ?? 50,
          cursor: args.cursor,
        }),
      ),
    ),
  );

  server.registerTool(
    "export_page",
    {
      description:
        "Export a page to a local file. A page without children is often a .md or .html file; include_children usually returns a zip. Writes to output_path or a temp file and returns the path plus content type.",
      annotations: hints("read"),
      inputSchema: {
        page_id: pageId,
        format: z.enum(["markdown", "html"]).optional(),
        include_children: z.boolean().optional(),
        include_attachments: z.boolean().optional(),
        output_path: z.string().optional().describe("Where to write the exported file"),
      },
    },
    wrap(client, "read", async (args) =>
      exportZip(client, "/pages/export", {
        pageId: args.page_id,
        format: args.format ?? "markdown",
        includeChildren: args.include_children,
        includeAttachments: args.include_attachments,
      }, args.output_path as string | undefined, `page-${args.page_id}`),
    ),
  );
}

function registerSpaceTools(server: McpServer, client: DocmostClient): void {
  server.registerTool(
    "list_spaces",
    {
      description: "List spaces the authenticated user can access.",
      annotations: hints("read"),
      inputSchema: { limit, cursor },
    },
    wrap(client, "read", async (args) => {
      const result = asItems(
        await client.request("/spaces", {
          limit: args.limit ?? 100,
          cursor: args.cursor,
        }),
      );
      return {
        items: result.items.map((item) => spaceSummary(item)),
        meta: result.meta,
      };
    }),
  );

  server.registerTool(
    "get_space",
    {
      description: "Get details for a space, including the current user's membership.",
      annotations: hints("read"),
      inputSchema: { space_id: spaceId },
    },
    wrap(client, "read", async (args) => {
      const id = await client.resolveSpaceId(String(args.space_id));
      return spaceSummary(await client.request("/spaces/info", { spaceId: id }));
    }),
  );

  server.registerTool(
    "create_space",
    {
      description: "Create a space. Slug is generated from the name if omitted. Requires permission to manage spaces.",
      annotations: hints("write"),
      inputSchema: {
        name: z.string().min(2).max(100),
        slug: z.string().min(2).max(100).optional(),
        description: z.string().optional(),
      },
    },
    wrap(client, "write", async (args) =>
      spaceSummary(
        await client.request("/spaces/create", {
          name: args.name,
          slug: args.slug ?? slugify(String(args.name)),
          description: args.description,
        }),
      ),
    ),
  );

  server.registerTool(
    "update_space",
    {
      description: "Update a space name, slug, or description.",
      annotations: hints("write"),
      inputSchema: {
        space_id: spaceId,
        name: z.string().min(2).max(100).optional(),
        slug: z.string().min(2).max(100).optional(),
        description: z.string().optional(),
      },
    },
    wrap(client, "write", async (args) =>
      spaceSummary(
        await client.request("/spaces/update", {
          spaceId: await client.resolveSpaceId(String(args.space_id)),
          name: args.name,
          slug: args.slug,
          description: args.description,
        }),
      ),
    ),
  );

  server.registerTool(
    "delete_space",
    {
      description: "Delete a space and its pages. This cannot be undone.",
      annotations: hints("destructive"),
      inputSchema: {
        space_id: spaceId,
        confirm: z.literal(true).describe("Must be true to confirm deletion"),
      },
    },
    wrap(client, "destructive", async (args) => {
      const id = await client.resolveSpaceId(String(args.space_id));
      await client.request("/spaces/delete", { spaceId: id });
      return { spaceId: id, deleted: true };
    }),
  );

  server.registerTool(
    "export_space",
    {
      description: "Export a whole space as a zip of Markdown or HTML. Writes to output_path or a temp file.",
      annotations: hints("read"),
      inputSchema: {
        space_id: spaceId,
        format: z.enum(["markdown", "html"]).optional(),
        include_attachments: z.boolean().optional(),
        output_path: z.string().optional(),
      },
    },
    wrap(client, "read", async (args) => {
      const id = await client.resolveSpaceId(String(args.space_id));
      return exportZip(
        client,
        "/spaces/export",
        {
          spaceId: id,
          format: args.format ?? "markdown",
          includeAttachments: args.include_attachments,
        },
        args.output_path as string | undefined,
        `space-${id}`,
      );
    }),
  );
}

function registerCommentTools(server: McpServer, client: DocmostClient): void {
  server.registerTool(
    "get_comments",
    {
      description:
        "List page-level comments. Content is returned as Markdown. Each comment is re-fetched so edits are not stale.",
      annotations: hints("read"),
      inputSchema: { page_id: pageId, limit, cursor },
    },
    wrap(client, "read", async (args) => {
      const result = asItems(
        await client.request("/comments", {
          pageId: args.page_id,
          limit: args.limit ?? 50,
          cursor: args.cursor,
        }),
      );
      const items = await Promise.all(
        result.items.map((item) => hydrateComment(client, item)),
      );
      return {
        items,
        meta: result.meta,
      };
    }),
  );

  server.registerTool(
    "create_comment",
    {
      description: "Add a page-level comment. Inline selection comments are not supported.",
      annotations: hints("write"),
      inputSchema: {
        page_id: pageId,
        markdown: z.string().min(1).describe("Comment body as Markdown"),
        parent_comment_id: z.string().uuid().optional().describe("Parent comment UUID to reply"),
      },
    },
    wrap(client, "write", async (args) =>
      commentSummary(
        await client.request("/comments/create", {
          pageId: args.page_id,
          content: client.commentContent(String(args.markdown)),
          type: "page",
          parentCommentId: args.parent_comment_id,
        }),
      ),
    ),
  );

  server.registerTool(
    "update_comment",
    {
      description: "Replace a comment body. You can update your own comments.",
      annotations: hints("write"),
      inputSchema: {
        comment_id: z.string().uuid(),
        markdown: z.string().min(1),
      },
    },
    wrap(client, "write", async (args) =>
      commentSummary(
        await client.request("/comments/update", {
          commentId: args.comment_id,
          content: client.commentContent(String(args.markdown)),
        }),
      ),
    ),
  );

  server.registerTool(
    "delete_comment",
    {
      description: "Delete a comment. Owners can delete their own; space admins can delete any comment.",
      annotations: hints("destructive"),
      inputSchema: { comment_id: z.string().uuid() },
    },
    wrap(client, "destructive", async (args) => {
      await client.request("/comments/delete", { commentId: args.comment_id });
      return { commentId: args.comment_id, deleted: true };
    }),
  );
}

function registerSearchTools(server: McpServer, client: DocmostClient): void {
  server.registerTool(
    "search_attachments",
    {
      description:
        "Search file attachments by name or indexed text. This is an Enterprise feature; Community Edition returns 403. Prefer get_attachment_info when you already have an attachment id.",
      annotations: hints("read"),
      inputSchema: {
        query: z.string().min(1),
        space_id: spaceId.optional(),
        limit,
      },
    },
    wrap(client, "read", async (args) => {
      const spaceIdValue = args.space_id
        ? await client.resolveSpaceId(String(args.space_id))
        : undefined;
      try {
        return asItems(
          await client.request("/search-attachments", {
            query: args.query,
            spaceId: spaceIdValue,
            limit: args.limit,
          }),
        );
      } catch (error) {
        throw attachmentSearchError(error);
      }
    }),
  );

  server.registerTool(
    "search_suggest",
    {
      description:
        "Typeahead suggestions. Pages are included by default (set include_pages=false to skip). Users and groups default to off.",
      annotations: hints("read"),
      inputSchema: {
        query: z.string().min(1),
        space_id: spaceId.optional(),
        include_users: z.boolean().optional(),
        include_groups: z.boolean().optional(),
        include_pages: z
          .boolean()
          .optional()
          .describe("Include page titles. Default true"),
        limit,
      },
    },
    wrap(client, "read", async (args) =>
      client.request("/search/suggest", {
        query: args.query,
        spaceId: args.space_id
          ? await client.resolveSpaceId(String(args.space_id))
          : undefined,
        includeUsers: args.include_users ?? false,
        includeGroups: args.include_groups ?? false,
        includePages: args.include_pages ?? true,
        limit: args.limit,
      }),
    ),
  );
}

function registerWorkspaceTools(server: McpServer, client: DocmostClient): void {
  server.registerTool(
    "get_current_user",
    {
      description:
        "Get the authenticated user and workspace context, detected Docmost version, and whether this session is read-only.",
      annotations: hints("read"),
    },
    wrap(client, "read", async () => {
      const me = (await client.request("/users/me", {})) as Json;
      const probe = await client.sessionInfo();
      return { ...me, ...probe };
    }),
  );

  server.registerTool(
    "list_workspace_members",
    {
      description: "List workspace members.",
      annotations: hints("read"),
      inputSchema: {
        limit,
        cursor,
        query: z.string().optional().describe("Optional member search text"),
      },
    },
    wrap(client, "read", async (args) =>
      asItems(
        await client.request("/workspace/members", {
          limit: args.limit ?? 50,
          cursor: args.cursor,
          query: args.query,
        }),
      ),
    ),
  );
}

function registerAttachmentTools(server: McpServer, client: DocmostClient): void {
  server.registerTool(
    "upload_attachment",
    {
      description: "Upload a local file to a page. Returns attachment metadata including the /api/files/:id/:name URL path.",
      annotations: hints("write"),
      inputSchema: {
        page_id: pageId,
        file_path: z.string().min(1).describe("Absolute path to a local file"),
      },
    },
    wrap(client, "write", async (args) => client.uploadFile(String(args.page_id), String(args.file_path))),
  );

  server.registerTool(
    "get_attachment_info",
    {
      description: "Get metadata for an uploaded attachment.",
      annotations: hints("read"),
      inputSchema: {
        attachment_id: z.string().uuid(),
      },
    },
    wrap(client, "read", async (args) => client.request("/files/info", { attachmentId: args.attachment_id })),
  );
}

function registerLabelTools(server: McpServer, client: DocmostClient): void {
  server.registerTool(
    "list_page_labels",
    {
      description: "List labels on a page.",
      annotations: hints("read"),
      inputSchema: { page_id: pageId, limit, cursor },
    },
    wrap(client, "read", async (args) =>
      asItems(
        await client.request("/pages/labels", {
          pageId: args.page_id,
          limit: args.limit ?? 50,
          cursor: args.cursor,
        }),
      ),
    ),
  );

  server.registerTool(
    "add_page_labels",
    {
      description: "Add one or more labels to a page. Names are normalized to lowercase kebab-case.",
      annotations: hints("write"),
      inputSchema: {
        page_id: pageId,
        names: z.array(z.string().min(1)).min(1).max(25),
      },
    },
    wrap(client, "write", async (args) =>
      client.request("/pages/labels/add", {
        pageId: args.page_id,
        names: (args.names as string[]).map(normalizeLabel).filter(Boolean),
      }),
    ),
  );

  server.registerTool(
    "remove_page_label",
    {
      description: "Remove a label from a page by label ID.",
      annotations: hints("write"),
      inputSchema: {
        page_id: pageId,
        label_id: z.string().uuid(),
      },
    },
    wrap(client, "write", async (args) => {
      await client.request("/pages/labels/remove", {
        pageId: args.page_id,
        labelId: args.label_id,
      });
      return { pageId: args.page_id, labelId: args.label_id, removed: true };
    }),
  );
}

function registerMemberTools(server: McpServer, client: DocmostClient): void {
  server.registerTool(
    "list_space_members",
    {
      description: "List members and groups in a space.",
      annotations: hints("read"),
      inputSchema: { space_id: spaceId, limit, cursor },
    },
    wrap(client, "read", async (args) =>
      asItems(
        await client.request("/spaces/members", {
          spaceId: await client.resolveSpaceId(String(args.space_id)),
          limit: args.limit ?? 50,
          cursor: args.cursor,
        }),
      ),
    ),
  );

  server.registerTool(
    "add_space_members",
    {
      description: "Add users and/or groups to a space with a role.",
      annotations: hints("write"),
      inputSchema: {
        space_id: spaceId,
        role: z.enum(["admin", "writer", "reader"]),
        user_ids: z.array(z.string().uuid()).optional(),
        group_ids: z.array(z.string().uuid()).optional(),
      },
    },
    wrap(client, "write", async (args) => {
      const userIds = (args.user_ids as string[] | undefined) ?? [];
      const groupIds = (args.group_ids as string[] | undefined) ?? [];
      if (userIds.length === 0 && groupIds.length === 0) {
        throw new Error("Provide user_ids or group_ids");
      }
      return client.request("/spaces/members/add", {
        spaceId: await client.resolveSpaceId(String(args.space_id)),
        role: args.role,
        userIds,
        groupIds,
      });
    }),
  );

  server.registerTool(
    "remove_space_member",
    {
      description: "Remove a user or group from a space.",
      annotations: hints("destructive"),
      inputSchema: {
        space_id: spaceId,
        user_id: z.string().uuid().optional(),
        group_id: z.string().uuid().optional(),
      },
    },
    wrap(client, "destructive", async (args) => {
      if (Boolean(args.user_id) === Boolean(args.group_id)) {
        throw new Error("Provide exactly one of user_id or group_id");
      }
      await client.request("/spaces/members/remove", {
        spaceId: await client.resolveSpaceId(String(args.space_id)),
        userId: args.user_id,
        groupId: args.group_id,
      });
      return { removed: true };
    }),
  );

  server.registerTool(
    "update_space_member_role",
    {
      description: "Change a space member or group's role.",
      annotations: hints("write"),
      inputSchema: {
        space_id: spaceId,
        role: z.enum(["admin", "writer", "reader"]),
        user_id: z.string().uuid().optional(),
        group_id: z.string().uuid().optional(),
      },
    },
    wrap(client, "write", async (args) => {
      if (Boolean(args.user_id) === Boolean(args.group_id)) {
        throw new Error("Provide exactly one of user_id or group_id");
      }
      return client.request("/spaces/members/change-role", {
        spaceId: await client.resolveSpaceId(String(args.space_id)),
        role: args.role,
        userId: args.user_id,
        groupId: args.group_id,
      });
    }),
  );
}

function spaceSummary(space: unknown): Json {
  if (!space || typeof space !== "object") {
    return { space };
  }
  const record = space as Json;
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    description: record.description,
    hostname: record.hostname,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    membership: record.membership,
    memberCount: record.memberCount,
  };
}

function commentSummary(comment: unknown): Json {
  if (!comment || typeof comment !== "object") {
    return { comment };
  }
  const record = comment as Json;
  const inner =
    record.comment && typeof record.comment === "object" ? (record.comment as Json) : record;
  const content = inner.content ?? inner.json ?? inner.body;
  return {
    id: inner.id,
    pageId: inner.pageId,
    parentCommentId: inner.parentCommentId,
    type: inner.type,
    creatorId: inner.creatorId,
    createdAt: inner.createdAt,
    updatedAt: inner.updatedAt,
    editedAt: inner.editedAt,
    resolvedAt: inner.resolvedAt,
    content: proseMirrorToMarkdown(content),
    creator: inner.creator,
  };
}

async function hydrateComment(client: DocmostClient, item: unknown): Promise<Json> {
  const summary = commentSummary(item);
  const id = summary.id;
  if (typeof id !== "string") {
    return summary;
  }
  try {
    const fresh = await client.request("/comments/info", { commentId: id });
    return commentSummary(fresh);
  } catch {
    return summary;
  }
}

function attachmentSearchError(error: unknown): Error {
  const status = error instanceof DocmostError ? error.status : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (status === 403 || /requires a valid license/i.test(message)) {
    return new DocmostError(
      "search_attachments requires a Docmost Enterprise license. Community Edition cannot search attachments through this endpoint (HTTP 403). Use get_attachment_info if you already have an attachment id.",
      403,
    );
  }
  return error instanceof Error ? error : new Error(message);
}

async function exportZip(
  client: DocmostClient,
  path: string,
  body: Json,
  outputPath: string | undefined,
  fallbackName: string,
): Promise<Json> {
  const response = await client.request<Response>(path, body, { raw: true });
  const bytes = Buffer.from(await response.arrayBuffer());
  const fileName = exportFileName({
    contentDisposition: response.headers.get("content-disposition"),
    contentType: response.headers.get("content-type"),
    bytes,
    fallbackBase: fallbackName,
  });
  const dest = outputPath ?? join(tmpdir(), fileName);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, bytes);
  return {
    path: dest,
    fileName,
    bytes: bytes.length,
    contentType: response.headers.get("content-type"),
  };
}
