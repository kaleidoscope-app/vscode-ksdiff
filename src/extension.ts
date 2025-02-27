import * as vscode from 'vscode';
import { Utils } from 'vscode-uri';
import { API as GitAPI, GitExtension, Repository, RepositoryState, Status, Change } from '../typings/git';
import { spawn, SpawnOptions } from 'child_process';
import simpleGit, { GitError } from 'simple-git';
import { sep } from 'path';

// Private Types Declaration
// https://github.com/Axosoft/vscode-gitlens/blob/main/src/commands/externalDiff.ts#L19-L49

/*eslint-disable */

export const enum ResourceGroupType {
	Merge,
	Index,
	WorkingTree,
	Untracked
}

/*eslint-enable */

interface Resource extends vscode.SourceControlResourceState {
	readonly resourceGroupType: ResourceGroupType;
	readonly type: Status;
}

function isWindowsPath(path: string): boolean {
	return /^[a-zA-Z]:\\/.test(path);
}

function isDescendant(parent: string, descendant: string): boolean {
	if (parent === descendant) {
		return true;
	}

	if (parent.charAt(parent.length - 1) !== sep) {
		parent += sep;
	}

	// Windows is case insensitive
	if (isWindowsPath(parent)) {
		parent = parent.toLowerCase();
		descendant = descendant.toLowerCase();
	}

	return descendant.startsWith(parent);
}

function git(repository: Repository, gitCommandAndArgs: string[]): void {
	simpleGit(repository.rootUri.fsPath).raw(
		gitCommandAndArgs,
		(err: any, result: any) => {
			if (err && err.message) {
				vscode.window.showWarningMessage('Git Reply: ' + err.message);
			}
		}
	);
}

function difftool(repository: Repository, additionalArgs: string[]): void {
	let config = vscode.workspace.getConfiguration('kaleidoscope');
	let tool = config.get('git.difftool') as string;
	if (tool === 'Kaleidoscope') {
		git(repository, ['difftool', '-y', '--tool=Kaleidoscope', ...additionalArgs]);
	} else {
		git(repository, ['difftool', '-y', ...additionalArgs]);
	}
}

function mergetool(repository: Repository, additionalArgs: string[]): void {
	let config = vscode.workspace.getConfiguration('kaleidoscope');
	let tool = config.get('git.mergetool') as string;
	if (tool === 'Kaleidoscope') {
		git(repository, ['mergetool', '-y', '--tool=Kaleidoscope', ...additionalArgs]);
	} else {
		git(repository, ['mergetool', '-y', ...additionalArgs]);
	}
}

async function getDiffTool(): Promise<string | undefined> {
	// Try to get the diff tool from the Settings and return it if it exists
	try {
		let config = vscode.workspace.getConfiguration('kaleidoscope');
		var diffPath = config.get('compareTool') as string;
			let uri = vscode.Uri.parse(diffPath);
		let stat = await vscode.workspace.fs.stat(uri);
		if (stat.type === (vscode.FileType.File | vscode.FileType.SymbolicLink)) {
			return diffPath;
		}
	} catch { }
	// If that did not work, try to find ksdiff in its default location
	try {
		diffPath = "/Applications/Kaleidoscope.app/Contents/MacOS/ksdiff";
		let uri = vscode.Uri.parse(diffPath);
		let stat = await vscode.workspace.fs.stat(uri);
		if (stat.type === vscode.FileType.File) {
			return diffPath;
		}	
	} catch { }
	// Report to the user that the tool could not be found
	const selection = await vscode.window.showErrorMessage('Kaleidoscope Compare Tool is not installed or not correctly configured.', 'Open Settings', 'Get Kaleidoscope');
	if (selection === 'Open Settings') {
		await vscode.commands.executeCommand(
			'workbench.action.openSettings',
			'kaleidoscope.compareTool'
		);
	} else if (selection === 'Get Kaleidoscope') {
		vscode.env.openExternal(vscode.Uri.parse('https://kaleidoscope.app'));
	}
	return undefined;
}

export function activate(context: vscode.ExtensionContext) {
	
	let extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
	if (!extension) { 
		return; 
	}
	let gitExtension = extension.exports;
	let gitAPI = gitExtension.getAPI(1);

	context.subscriptions.push(
		vscode.commands.registerCommand('kaleidoscope.diff', async (uri?: vscode.Uri, uris?: [vscode.Uri]) => {
			// This is the new catch-all function trying to handle all cases
			let workspaceName = vscode.workspace.name ?? "VSCode";
			var paths: string[] = [];

			const visibleEditors = vscode.window.visibleTextEditors;
			if (visibleEditors.length === 2) {
				// First, check if we have two visible editors, which would be a comparison of sorts
      			const leftEditor = visibleEditors[0];
      			const rightEditor = visibleEditors[1];
		      	const leftUri = leftEditor.document.uri;
      			const rightUri = rightEditor.document.uri;
				let leftPath: string = leftUri.fsPath;
				let rightPath: string = rightUri.fsPath;
				if (leftPath === rightPath) {
					// If the paths are the same, we are comparing the same file
					// Check if there is a git conflict for that file.
					// Depending on that, we will call git mergetool or git difftool
					const repository = gitAPI.repositories.filter(r => isDescendant(r.rootUri.fsPath, leftPath))[0];
					const isConflicted = repository.state.mergeChanges.some(f => f.uri.fsPath === leftPath && f.status === Status.BOTH_MODIFIED);
					if (isConflicted) {
						mergetool(repository, [leftPath]);
					} else {
						difftool(repository, [leftPath]);
					}
					return;
				} else {
					// If the paths are different, we are comparing two different files.
					paths = [leftPath, rightPath];
				}
			} else {
				if (uris && uris?.length > 0) {
					// If we received multiple Uris, use those
					paths = uris.map(r => r.fsPath);
				} else if (uri) {
					// Othweise we may have received a single Uri
					paths = [uri.path];
				} else if (vscode.window.activeTextEditor) {
					// If none of the above worked, also try to use the Uri of the active text editor as fallback
					let docUri = vscode.window.activeTextEditor.document.uri;
					if (docUri?.fsPath) {
						paths = [docUri.fsPath];
					}
				}
				if (paths.length === 1) {
					// If we have a single file, do a conflict check before just opening it
					const path = paths[0];
					const repository = gitAPI.repositories.filter(r => isDescendant(r.rootUri.fsPath, path))[0];
					const isConflicted = repository.state.mergeChanges.some(f => f.uri.fsPath === path && f.status === Status.BOTH_MODIFIED);
					if (isConflicted) {
						return mergetool(repository, [path]);
					}
				}
			}
			if (paths.length === 0) {
				return;
			}

			let spawnOptions: SpawnOptions;
			spawnOptions = {
				detached: true
			};
			let diffPath = await getDiffTool();
			if (!diffPath) {
				return;
			}
			const diff = spawn(diffPath, ['-l', workspaceName, ...paths], spawnOptions);
			diff.stdin?.end();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerTextEditorCommand('kaleidoscope.diffSelectedText', async (textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit) => {
			// This function is meant to be called on a text selection in the editor
			// Still, do a check for a  git conflict before just comparig text.
			const fileUri = textEditor.document.uri;
			const repository = gitAPI.repositories.filter(r => isDescendant(r.rootUri.fsPath, fileUri.fsPath))[0];
			const isConflicted = repository.state.workingTreeChanges.some(f => f.uri.fsPath === fileUri.fsPath && f.status === Status.BOTH_MODIFIED);
			if (isConflicted) {
				mergetool(repository, [fileUri.fsPath]);
				return;
			}

			const selection = textEditor.selection;
			const text = textEditor.document.getText(selection);

			let spawnOptions: SpawnOptions;
			spawnOptions = {
				detached: true
			};
			let workspaceName = vscode.workspace.name ?? "VSCode";
			let diffPath = await getDiffTool();
			if (!diffPath) {
				return;
			}
			const diff = spawn(diffPath, ['-l', workspaceName, '-'], spawnOptions);
			diff.stdin?.write(text);
			diff.stdin?.end();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kaleidoscope.diffScm', (...resourceStates: [vscode.SourceControlResourceState]) => {
			if (!resourceStates.length) {
				vscode.window.showInformationMessage('The repository does not have any changes.');
				return;
			}

			let paths = resourceStates.map(r => r.resourceUri.fsPath);
			let repository = gitAPI.repositories.filter(r => isDescendant(r.rootUri.fsPath, paths[0]))[0];

			if (paths.length === 1) {
				if ((resourceStates[0] as Resource).resourceGroupType === ResourceGroupType.Index) {
					difftool(repository, ['--staged', ...paths]);
				} else {
					difftool(repository, paths);
				}
			} else {
				// Diff Staged and Unstaged: HEAD
				difftool(repository, ['HEAD', ...paths]);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kaleidoscope.mergeScm', (...resourceStates: [vscode.SourceControlResourceState]) => {
			if (!resourceStates.length) {
				vscode.window.showInformationMessage('The repository does not have any changes.');
				return;
			}

			let paths = resourceStates.map(r => r.resourceUri.fsPath);
			let repository = gitAPI.repositories.filter(r => isDescendant(r.rootUri.fsPath, paths[0]))[0];

			mergetool(repository, paths);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kaleidoscope.showAllStagedChanges', (group: vscode.SourceControlResourceGroup) => {
			if (!group.resourceStates.length) {
				vscode.window.showInformationMessage('The repository does not have any changes.');
				return;
			}
			let resourceState = group.resourceStates[0];

			let fullTargetFilePath: string = resourceState.resourceUri.fsPath;
			let repository = gitAPI.repositories.filter(r => isDescendant(r.rootUri.fsPath, fullTargetFilePath))[0];
	
			difftool(repository, ['--staged']);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kaleidoscope.showAllUnstagedChanges', (group: vscode.SourceControlResourceGroup) => {
			if (!group.resourceStates.length) {
				vscode.window.showInformationMessage('The repository does not have any changes.');
				return;
			}
			let resourceState = group.resourceStates[0];

			let fullTargetFilePath: string = resourceState.resourceUri.fsPath;
			let repository = gitAPI.repositories.filter(r => isDescendant(r.rootUri.fsPath, fullTargetFilePath))[0];
	
			difftool(repository, []);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kaleidoscope.showStagedChangesInFolder', (resourceState: vscode.SourceControlResourceState) => {
			let path: string = Utils.dirname(resourceState.resourceUri).fsPath;
			let repository = gitAPI.repositories.filter(r => isDescendant(r.rootUri.fsPath, path))[0];
	
			difftool(repository, ['--staged', path]);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kaleidoscope.showUnstagedChangesInFolder', (resourceState: vscode.SourceControlResourceState) => {
			let path: string = Utils.dirname(resourceState.resourceUri).fsPath;
			let repository = gitAPI.repositories.filter(r => isDescendant(r.rootUri.fsPath, path))[0];
	
			difftool(repository, [path]);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kaleidoscope.showAllChangesFromScmTitle', () => {
			for (const repository of gitAPI.repositories) {
				// Diff Staged and Unstaged: HEAD
				difftool(repository, ['HEAD']);
			}
		})
	);

	
}

export function deactivate() {}
