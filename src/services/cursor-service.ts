import * as vscode from "vscode";
import * as os from "os";
import { spawn } from "child_process";
import { Risk } from "../types/risk";

export class CursorService {
  private static instance: CursorService;

  private constructor() {}

  static getInstance(): CursorService {
    if (!CursorService.instance) {
      CursorService.instance = new CursorService();
    }
    return CursorService.instance;
  }

  /**
   * Helper function to send keyboard shortcuts to Cursor to automatically open chat
   */
  async openCursorChatAutomatically(logger: vscode.OutputChannel): Promise<boolean> {
    const platform = os.platform();
    
    try {
      logger.appendLine(`=== Attempting to open Cursor chat automatically on ${platform} ===`);
      
      if (platform === 'darwin') {
        // macOS - use AppleScript
        const script = `
                  tell application "Cursor"
          activate
          delay 0.2
        end tell
        
        tell application "System Events"
          -- Send Cmd+I to open chat
          key code 34 using command down
          delay 0.3
          -- Send Cmd+N for new chat  
          key code 45 using command down
          delay 0.2
          -- Send Cmd+V to paste
          key code 9 using command down
          delay 0.2
          -- Send Enter to submit
          key code 36
        end tell
        `;
        
        logger.appendLine(`Executing AppleScript to open Cursor chat...`);
        
        return new Promise((resolve) => {
          const process = spawn('osascript', ['-e', script]);
          
          process.on('close', (code) => {
            logger.appendLine(`AppleScript completed with code: ${code}`);
            resolve(code === 0);
          });
          
          process.on('error', (error) => {
            logger.appendLine(`AppleScript error: ${error.message}`);
            resolve(false);
          });
        });
        
      } else if (platform === 'win32') {
        // Windows - use PowerShell
        const script = `
          Add-Type -AssemblyName System.Windows.Forms
          
          # Focus Cursor (assuming it's running)
          $cursor = Get-Process -Name "Cursor" -ErrorAction SilentlyContinue
          if ($cursor) {
            [Microsoft.VisualBasic.Interaction]::AppActivate($cursor.Id)
            Start-Sleep -Milliseconds 200
            
            # Send Ctrl+I
            [System.Windows.Forms.SendKeys]::SendWait("^i")
            Start-Sleep -Milliseconds 300
            
            # Send Ctrl+N  
            [System.Windows.Forms.SendKeys]::SendWait("^n")
            Start-Sleep -Milliseconds 200
            
            # Send Ctrl+V
            [System.Windows.Forms.SendKeys]::SendWait("^v")
            Start-Sleep -Milliseconds 200
            
            # Send Enter to submit
            [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
          }
        `;
        
        logger.appendLine(`Executing PowerShell to open Cursor chat...`);
        
        return new Promise((resolve) => {
          const process = spawn('powershell', ['-Command', script]);
          
          process.on('close', (code) => {
            logger.appendLine(`PowerShell completed with code: ${code}`);
            resolve(code === 0);
          });
          
          process.on('error', (error) => {
            logger.appendLine(`PowerShell error: ${error.message}`);
            resolve(false);
          });
        });
        
      } else {
        // Linux - use xdotool if available
        logger.appendLine(`Attempting to use xdotool on Linux...`);
        
        return new Promise((resolve) => {
          // First check if xdotool is available
          const checkProcess = spawn('which', ['xdotool']);
          
          checkProcess.on('close', (code) => {
            if (code !== 0) {
              logger.appendLine(`xdotool not found. Install with: sudo apt-get install xdotool`);
              resolve(false);
              return;
            }
            
            // Execute the keyboard shortcuts
            const script = `
                          # Focus Cursor window
            xdotool search --name "Cursor" windowactivate --sync
            sleep 0.2
            
            # Send Ctrl+I
            xdotool key ctrl+i
            sleep 0.3
            
            # Send Ctrl+N
            xdotool key ctrl+n
            sleep 0.2
            
            # Send Ctrl+V
            xdotool key ctrl+v
            sleep 0.2
            
            # Send Enter to submit
            xdotool key Return
            `;
            
            const process = spawn('bash', ['-c', script]);
            
            process.on('close', (code) => {
              logger.appendLine(`xdotool completed with code: ${code}`);
              resolve(code === 0);
            });
            
            process.on('error', (error) => {
              logger.appendLine(`xdotool error: ${error.message}`);
              resolve(false);
            });
          });
        });
      }
      
    } catch (error: any) {
      logger.appendLine(`Error in openCursorChatAutomatically: ${error.message}`);
      return false;
    }
  }

  /**
   * Opens Cursor chat with risk context message
   */
  async openCursorChatWithRisk(risk: Risk): Promise<void> {
    const logger = vscode.window.createOutputChannel("Apiiro-AutoFix");
    
    try {
      logger.appendLine(`=== OpenCursorChat Command Called ===`);
      logger.appendLine(`Raw argument received: ${JSON.stringify(risk)}`);
      logger.appendLine(`Type of argument: ${typeof risk}`);
      logger.appendLine(`Is undefined: ${risk === undefined}`);
      logger.appendLine(`Is null: ${risk === null}`);
      
      // Handle undefined or null risk
      if (!risk || risk === undefined || risk === null) {
        logger.appendLine(`ERROR: Risk object is undefined/null`);
        vscode.window.showErrorMessage('Risk data is missing. Cannot open Cursor chat.');
        return;
      }
      
      // Extract file path and line number from risk object
      const filePath = risk.sourceCode?.filePath;
      const lineNumber = risk.sourceCode?.lineNumber;
      logger.appendLine(`File path from object: ${filePath}`);
      logger.appendLine(`Line number from object: ${lineNumber}`);
      
      if (!filePath) {
        logger.appendLine(`ERROR: File path is missing from risk object`);
        vscode.window.showErrorMessage('File path is missing from risk data. Cannot open Cursor chat.');
        return;
      }
      
      if (lineNumber === undefined || lineNumber === null) {
        logger.appendLine(`ERROR: Line number is missing from risk object`);
        vscode.window.showErrorMessage('Line number is missing from risk data. Cannot open Cursor chat.');
        return;
      }
      
      logger.appendLine(`Using file path: "${filePath}" and line number: ${lineNumber}`);
      
      // Create a formatted message for the clipboard
      const chatMessage = `Please provide context from apiiro about the security risk at ${filePath}:${lineNumber}`;
      
      // Copy formatted message to clipboard
      await vscode.env.clipboard.writeText(chatMessage);
      logger.appendLine(`Successfully copied to clipboard: "${chatMessage}"`);
      
      // Try to automatically open Cursor chat and paste
      logger.appendLine(`Attempting automatic Cursor chat opening...`);
      const automaticSuccess = await this.openCursorChatAutomatically(logger);
      
      if (automaticSuccess) {
        logger.appendLine(`✅ Successfully opened Cursor chat automatically!`);
        vscode.window.showInformationMessage(
          `✨ Opened Cursor chat automatically with risk context message!`,
          'Got it!'
        );
        
      } else {
        logger.appendLine(`⚠️ Automatic opening failed, showing manual instructions...`);
        
        // Fall back to manual instructions if automatic fails
        const action = await vscode.window.showInformationMessage(
          `Risk context message copied to clipboard! Automatic opening failed - please manually open Cursor chat (Cmd+I, then Cmd+N) and paste.`,
          'Got it!',
          'Open Instructions',
          'Try Auto Again'
        );
        
        logger.appendLine(`User action: ${action || 'dismissed'}`);
        
        if (action === 'Try Auto Again') {
          logger.appendLine(`User requested retry of automatic opening...`);
          const retrySuccess = await this.openCursorChatAutomatically(logger);
          if (retrySuccess) {
            vscode.window.showInformationMessage(`✨ Successfully opened Cursor chat on retry!`);
          } else {
            vscode.window.showWarningMessage(`Automatic opening failed again. Please try manually.`);
          }
        }
      }
      
      logger.appendLine(`=== Command completed successfully ===`);
      
    } catch (error: any) {
      logger.appendLine(`=== ERROR in openCursorChat ===`);
      logger.appendLine(`Error type: ${typeof error}`);
      logger.appendLine(`Error message: ${error?.message || 'Unknown error'}`);
      logger.appendLine(`Error stack: ${error?.stack || 'No stack trace'}`);
      logger.appendLine(`Full error object: ${JSON.stringify(error, null, 2)}`);
      
      vscode.window.showErrorMessage(`Failed to copy risk ID: ${error?.message || error}`);
      logger.show(); // Show the log channel to help debug
    }
  } 
} 