import type { PluginClientContext, PluginSidebarItemProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { WorklogBoardScreen } from "./client/board-screen";

function WorklogSidebar({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="ListTodo" active={currentScreen?.screenId === "board"} onPress={() => openScreen({ screenId: "board" })} />;
}

function WorklogPanel(props: PluginWorkspacePanelProps) {
  return <WorklogBoardScreen {...props} params={{}} />;
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "board", title: "Worklog · 작업 보드", Component: WorklogBoardScreen });
  client.addSidebarHeaderItem({ id: "board", title: "Worklog", Component: WorklogSidebar });
  client.addWorkspacePanel({ id: "board", title: "Worklog", icon: "ListTodo", context: "workspace", Component: WorklogPanel });
  client.addCommandCenterItem({ id: "open-board", title: "Worklog 작업 보드 열기", icon: "ListTodo", context: "global", onSelect({ openScreen }) { openScreen({ screenId: "board" }); } });
  client.addSlashCommand({ name: "worklog", description: "할 일·한 일·다음 행동을 기록하는 작업 보드", argumentHint: "", context: "workspace", onSubmit({ openScreen }) { openScreen({ screenId: "board" }); } });
  return () => {};
}
