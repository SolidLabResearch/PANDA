import csv

# Define output file paths
output_files = {
    "acc-x": "/home/kush/Code/RSP/solid-stream-aggregator-evaluation/evaluation-analysis/8min/acc_x.csv",
    "acc-y": "/home/kush/Code/RSP/solid-stream-aggregator-evaluation/evaluation-analysis/8min/acc_y.csv",
    "acc-z": "/home/kush/Code/RSP/solid-stream-aggregator-evaluation/evaluation-analysis/8min/acc_z.csv"
}

# Open each output file for writing and initialize CSV writers
output_writers = {}
file_handles = {}  # To store file handles for later closing
for key, filename in output_files.items():
    f = open(filename, "w", newline="")
    writer = csv.writer(f)
    writer.writerow(["timestamp", "sequence_number", "uri", "observation"])  # Write header
    output_writers[key] = writer
    file_handles[key] = f

# Process the data based on URI
with open("/home/kush/Code/RSP/solid-stream-aggregator-evaluation/evaluation-analysis/8min/replayer-log.csv", "r") as infile:
    reader = csv.DictReader(infile)
    for row in reader:
        uri = row.get("uri")
        
        # Check if uri is not None before processing
        if uri:
            if "acc-x" in uri:
                output_writers["acc-x"].writerow([row["timestamp"], row["sequence_number"], uri, row["observation"]])
            elif "acc-y" in uri:
                output_writers["acc-y"].writerow([row["timestamp"], row["sequence_number"], uri, row["observation"]])
            elif "acc-z" in uri:
                output_writers["acc-z"].writerow([row["timestamp"], row["sequence_number"], uri, row["observation"]])

# Close all output files
for f in file_handles.values():
    f.close()
