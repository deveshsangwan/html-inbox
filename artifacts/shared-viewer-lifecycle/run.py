import subprocess, sys, pathlib
folder = pathlib.Path(__file__).parent
name, *command = sys.argv[1:]
with (folder / (name + '.log')).open('w') as output:
    output.write('$ ' + ' '.join(command) + '\n'); output.flush()
    result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT)
    output.write('\nEXIT ' + str(result.returncode) + '\n')
print(name, 'exit', result.returncode)
sys.exit(result.returncode)
