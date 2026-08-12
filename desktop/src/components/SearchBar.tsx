import "./SearchBar.css";

export function SearchBar() {
    return(
        <div id={"searchBar"}>
            <input id="input" type="text" placeholder="What are you itching for?" />
            <select id="select">
                <option>Tidal</option>
                <option>Qobuz</option>
                <option>Spotify</option>
            </select>
        </div>
    )
}