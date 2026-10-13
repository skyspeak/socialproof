-- X Bookmarks: sync now, and renew the X login, without a terminal.
-- This file is only dialogs. The work is done by ~/.x_reader/helper.sh,
-- which the daily job's runtime already lives next to.

on helperCmd()
	return quoted form of ((POSIX path of (path to home folder)) & ".x_reader/helper.sh")
end helperCmd

on runHelper(args)
	return do shell script helperCmd() & " " & args
end runHelper

on showMessage(msg)
	display dialog msg buttons {"OK"} default button "OK" with title "X Bookmarks" with icon note
end showMessage

on updateLogin()
	set intro to "Paste two values from your normal browser's X session." & return & return & ¬
		"1. Open x.com and make sure you are signed in." & return & ¬
		"2. Open Developer Tools (Option-Command-I in Chrome), then Application, then Cookies, then https://x.com." & return & ¬
		"3. Copy the Value of auth_token, then of ct0." & return & return & ¬
		"They work like a password for your X account. They are kept only in ~/.x_reader/.env."
	repeat
		set answer to display dialog intro buttons {"Cancel", "Open x.com", "Continue"} default button "Continue" with title "Update X login" with icon note
		if button returned of answer is "Open x.com" then
			open location "https://x.com"
		else
			exit repeat
		end if
	end repeat
	set authToken to text returned of (display dialog "auth_token:" default answer "" with hidden answer with title "Update X login")
	set ct0Value to text returned of (display dialog "ct0:" default answer "" with hidden answer with title "Update X login")
	
	-- Hand the values over in a private file, not on a command line where
	-- other programs could read them.
	set tmp to (POSIX path of (path to home folder)) & ".x_reader/.cookies.tmp"
	do shell script "umask 077; : > " & quoted form of tmp
	set f to open for access POSIX file tmp with write permission
	try
		set eof f to 0
		write authToken & linefeed & ct0Value & linefeed to f
		close access f
	on error
		try
			close access f
		end try
		do shell script "rm -f " & quoted form of tmp
		error "Could not write the temporary file."
	end try
	return runHelper("apply-cookies " & quoted form of tmp)
end updateLogin

on run
	repeat
		set statusText to ""
		try
			set statusText to runHelper("status")
		on error errText
			set statusText to "Could not read the status: " & errText
		end try
		set answer to display dialog statusText buttons {"Close", "Update X login", "Sync now"} default button "Sync now" with title "X Bookmarks to Trendwire" with icon note
		set choice to button returned of answer
		if choice is "Close" then exit repeat
		try
			if choice is "Sync now" then
				display notification "Syncing your bookmarks. This can take a few minutes." with title "X Bookmarks"
				with timeout of 1500 seconds
					set out to runHelper("sync")
				end timeout
				showMessage(out)
			else
				showMessage(updateLogin())
			end if
		on error errText number errNum
			if errNum is not -128 then showMessage("Something went wrong: " & errText)
		end try
	end repeat
end run
